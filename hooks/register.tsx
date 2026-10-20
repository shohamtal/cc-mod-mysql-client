import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SqlConfirm, SqlResult, SqlSchema, SqlServer, SqlUnlock, SqlView, SqlWritePrompt } from '../types'
import { FUNCTIONS, KEYWORDS } from './editor'
import {
  findMatches,
  formatSql,
  highlight,
  MYSQL_CANDIDATES,
  mysqlInvocation,
  mysqlScript,
  parseArgs,
  parseBatch,
  parseStatements,
  readGuard,
  rowOf,
  schemaQuery,
  sliceSegs,
  statementAt,
  tableLines,
  toTsv,
  type DbServer,
  type Line,
  normalizeServer,
  tagColor,
  PASTE_COMMANDS,
  COPY_COMMANDS,
  credentialSource,
  credentialFingerprint,
  asciiView,
  classifyStatement,
  mysqlWriteScript,
  pageFrom,
  wrapRows,
  GUIDE,
} from './lib'

const PANE = 'sql'
const query = atom({ plugin: 'mysql-client', key: 'query' } as const, '')
const rev = atom({ plugin: 'mysql-client', key: 'rev' } as const, 0)
const cursorRow = atom({ plugin: 'mysql-client', key: 'cursorRow' } as const, 0)
const result = atom({ plugin: 'mysql-client', key: 'result' } as const, null)
const running = atom({ plugin: 'mysql-client', key: 'running' } as const, false)
const server = atom({ plugin: 'mysql-client', key: 'server' } as const, '')
const database = atom({ plugin: 'mysql-client', key: 'database' } as const, '')
const servers = atom({ plugin: 'mysql-client', key: 'servers' } as const, [])
const showHelp = atom({ plugin: 'mysql-client', key: 'showHelp' } as const, false)
const paste = atom({ plugin: 'mysql-client', key: 'paste' } as const, null)
const schema = atom({ plugin: 'mysql-client', key: 'schema' } as const, {})
const schemaLoading = atom({ plugin: 'mysql-client', key: 'schemaLoading' } as const, '')
const paths = atom({ plugin: 'mysql-client', key: 'paths' } as const, null)
const editorScroll = atom({ plugin: 'mysql-client', key: 'editorScroll' } as const, null)
const EMPTY_VIEW: SqlView = { expanded: [], top: 0, cursor: 0, left: 0, search: '', match: 0 }
const view = atom({ plugin: 'mysql-client', key: 'view' } as const, EMPTY_VIEW)
const menuOpen = atom({ plugin: 'mysql-client', key: 'menuOpen' } as const, '')
const editorCmd = atom({ plugin: 'mysql-client', key: 'editorCmd' } as const, null)
const confirm = atom({ plugin: 'mysql-client', key: 'confirm' } as const, null)
// Servers whose writes the person unlocked from the pane, for this session only. Never read from disk.
const unlocked = atom({ plugin: 'mysql-client', key: 'unlocked' } as const, [])
// Ids and hosts seen tagged production: removing the tag later doesn't count.
const prodSeen = atom({ plugin: 'mysql-client', key: 'prodSeen' } as const, [])
// The longest statement a write prompt shows; longer ones can't be approved from a prompt.
const SQL_LIMIT = 20_000

const HELP = `**Top bar**
- **▾ Server** / **▾ Database** — open the list and pick one (from \`servers.json\`; ● is active; production is red) · **🔒 / 🔓** writes locked / on · **↶ ↷** undo / redo
- **Format** — uppercase SQL keywords · **↻ Schema** — reload table and column names · **Help** — this screen

**Editor** (click it to type)
- \`ctrl+r\` / \`ctrl+enter\` or click **▶** in the gutter — run that statement (statements end with \`;\` or a blank line)
- Autocomplete: tables after FROM/JOIN, columns in SELECT/WHERE/ON/BY, \`db.\` → its tables, \`alias.\` → that table's columns, keywords elsewhere · ↑↓ pick, Tab/Enter accept
- Select: shift+arrows, mouse drag, shift+click · \`ctrl+a\` select all · \`ctrl+c\` / \`ctrl+x\` / \`ctrl+v\`
- \`alt+z\` undo · \`alt+y\` / \`alt+shift+z\` redo, or the ↶ ↷ buttons (\`ctrl+z\` suspends Claude Code)
- \`ctrl+l\` format · Home/End · \`ctrl+k\` delete to line end · Tab = 2 spaces

**Result** (click it first)
- Mouse wheel scrolls the editor or the result (whichever is under the pointer)
- Drag the result left or right to scroll its columns (terminals don't pass a sideways swipe to the pane), or use ← →
- Selecting text with the mouse copies it; Cmd+C belongs to the terminal and never reaches the pane (ctrl+c copies the selection or line)
- \`↑↓\` / \`j k\` move · PgUp/PgDn · \`g\`/\`G\` · \`←\`/\`→\` (or \`h\`/\`l\`) scroll columns, shift for faster
- Enter / Space / click — open a row as column: value lines · \`e\` open all · \`c\` close all
- \`y\` copy as TSV · \`J\` copy as JSON · \`/\` or \`ctrl+f\` find · \`n\`/\`N\` next/previous

**Writes are locked** — reads (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, TABLE, VALUES) run one statement at a time inside a read-only session and transaction. A write (INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP, TRUNCATE, RENAME, GRANT, REVOKE, CALL) opens a prompt that shows the exact statement: **Run this statement once**, **Unlock for this session** (not on production servers) or **Cancel**; 🔒 / 🔓 shows and resets the lock. DDL can't be rolled back, and the prompt says so. Always refused: files (LOAD, OUTFILE, LOAD_FILE), session or server control (SET, transactions, locks, KILL, SHUTDOWN, plugins), server objects, creating routines / triggers / events, system schemas, and more than one statement.

**Files** — one JSON session file per console (default \`~/.claude/mods/sql/sessions/default.json\`: server, database, cursorRow, query, lastRun) + \`<name>.result.json\`; servers in \`~/.claude/mods/sql/servers.json\`. Edits show here live.

**Own console per session/agent** — \`/sql --filepath <name>.json [--configfilepath <servers>.json]\`.

Esc returns the keyboard to the prompt · \`/sql\` toggles this pane.`

const DEFAULT_SERVERS = {
  _help:
    'One entry per MySQL server, listed in the pane\'s server menu by name. Fields: id, name, host, port (3306), https (TLS required), username, password or passwordEnv (an environment variable) or passwordCommand (argv whose output is the password), tag (production | staging | development | local), databases (empty: SHOW DATABASES), maxRows (1000), timeoutSec (60), mysqlPath. Use a read-only database user.',
  servers: [{ id: 'local', name: 'Local', host: 'localhost', port: 3306, https: false, username: '', password: '', tag: 'local', databases: [] }],
}

const DEFAULT_CONSOLE = `-- Read-only console: SELECT / SHOW / DESCRIBE / EXPLAIN. Click ▶ or press ctrl+r to run.
SHOW TABLES;

SELECT *
FROM users
LIMIT 10;
`

// Where this session's console lives. Kept in $.state so a reload finds them again.
let base = ''
let sessionFile = ''
let configFile = ''
const seen: Record<string, number> = {}
// The session file's text as this pane last read or wrote it: two writes within one mtime tick
// still differ in content.
const seenText: Record<string, string> = {}
let saveTimer: Timer | undefined
let viewerHeight = 20
let viewerWidth = 80
let editorBottom = 14
let model: { id: number; expandedKey: string; lines: Line[] } | undefined
let matchCache: { key: string; paths: string[] } | undefined

const resultFile = () => sessionFile.replace(/(\.json)?$/, '.result.json')
const schemaFile = () => `${base}/schema.json`
const serverKey = (s: { id: string; host: string }) => `${s.id}@${s.host}`

// The system clipboard first (pbcopy, wl-copy, xclip, clip.exe): the terminal's own route (OSC 52)
// is off by default in iTerm2 and missing in Terminal.app, where it reports success and copies nothing.
async function copyText($: EngineInterface, text: string): Promise<boolean> {
  for (const argv of COPY_COMMANDS) {
    const out = await $.process.run(argv, { stdin: text, timeoutMs: 5_000 }).catch(() => undefined)
    if (out && out.exitCode === 0) return true
  }
  return (await $.ui.copy({ text })).isCopied
}

async function resolvePath($: EngineInterface, p: string, under: string): Promise<string> {
  // HOME on macOS / Linux; USERPROFILE on Windows.
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p.startsWith('/')) return p
  return `${under}/${p}`
}

async function write($: EngineInterface, file: string, text: string) {
  // Recorded before the write: a sync landing between the write and the stat knows it's ours.
  seenText[file] = text
  await $.fs.write(file, text)
  seen[file] = (await $.fs.stat(file)).mtimeMs
}

async function readJson($: EngineInterface, file: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return undefined
  }
}

async function readServers($: EngineInterface): Promise<DbServer[]> {
  const data = await readJson($, configFile)
  const list: unknown[] = Array.isArray(data?.servers) ? data.servers : []
  return list.map(x => normalizeServer(x)).filter((s): s is DbServer => !!s)
}

// The password from the file, an environment variable or a command (keychain, 1Password, pass).
async function passwordOf($: EngineInterface, s: DbServer): Promise<string> {
  if (s.passwordCommand) {
    const out = await $.process.run(s.passwordCommand, { timeoutMs: 15_000 })
    if (out.exitCode !== 0) throw new Error(`passwordCommand for ${s.name} exited ${out.exitCode}`)
    return out.stdout.replace(/\r?\n$/, '')
  }
  if (s.passwordEnv) {
    // $.env.get takes only literal names, so a configured variable is read through printenv.
    const out = await $.process.run(['printenv', s.passwordEnv]).catch(() => undefined)
    return out && out.exitCode === 0 ? out.stdout.replace(/\r?\n$/, '') : ''
  }
  return s.password ?? ''
}

// Approved credential fingerprints live in the mod's own store, not in a file the console reads.
async function isTrusted($: EngineInterface, s: DbServer): Promise<boolean> {
  if (!credentialSource(s)) return true
  const trusted = ((await $.store.get('trusted')) as string[] | undefined) ?? []
  return trusted.includes(credentialFingerprint(s))
}

async function trust($: EngineInterface, fingerprint: string) {
  const trusted = ((await $.store.get('trusted')) as string[] | undefined) ?? []
  if (!trusted.includes(fingerprint)) await $.store.set('trusted', [...trusted, fingerprint].slice(-200))
}

async function withPassword($: EngineInterface, s: DbServer): Promise<DbServer> {
  return { ...s, password: await passwordOf($, s) }
}

// The databases a server offers: its configured list, else what its schema read found.
async function databasesOf($: EngineInterface, s: SqlServer | undefined): Promise<string[]> {
  if (!s) return []
  if (s.databases.length) return s.databases
  return ((await read($, schema)) ?? {})[serverKey(s)]?.dbs ?? []
}

function linesOf(r: SqlResult, v: SqlView): Line[] {
  const key = v.expanded.join(',')
  if (model?.id === r.id && model.expandedKey === key) return model.lines
  const lines = r.error ? r.error.split('\n').map((l, i) => ({ path: `e${i}`, depth: 0, fold: false, segs: [['  ', 'f'], [l, 'e']] as [string, string][] })) : tableLines(r.columns, r.rows, new Set(v.expanded))
  model = { id: r.id, expandedKey: key, lines }
  return lines
}

function matchesOf(r: SqlResult, v: SqlView) {
  const key = JSON.stringify([r.id, v.expanded, v.search])
  if (matchCache?.key !== key) matchCache = { key, paths: findMatches(linesOf(r, v), v.search) }
  return matchCache.paths
}

function keepVisible(v: SqlView, count: number): SqlView {
  const cursor = Math.max(0, Math.min(v.cursor, count - 1))
  let top = Math.max(0, Math.min(v.top, Math.max(0, count - viewerHeight)))
  if (cursor < top) top = cursor
  if (cursor >= top + viewerHeight) top = cursor - viewerHeight + 1
  return { ...v, cursor, top, left: Math.max(0, v.left) }
}

function jump(r: SqlResult, v: SqlView, idx: number): SqlView {
  const found = matchesOf(r, v)
  if (!found.length) return { ...v, match: 0 }
  const match = ((idx % found.length) + found.length) % found.length
  const cursor = Math.max(0, linesOf(r, v).findIndex(l => l.path === found[match]))
  return { ...v, match, cursor, top: Math.max(0, cursor - Math.floor(viewerHeight / 2)) }
}

async function editView($: EngineInterface, fn: (v: SqlView, r: SqlResult) => SqlView) {
  const r = await read($, result)
  if (!r) return
  await update($, view, v => {
    const next = fn(v ?? EMPTY_VIEW, r)
    return keepVisible(next, linesOf(r, next).length)
  })
}

// ---- files → state ----

async function changed($: EngineInterface, file: string): Promise<boolean> {
  let mtime: number
  try {
    mtime = (await $.fs.stat(file)).mtimeMs
  } catch {
    return false
  }
  if (seen[file] === mtime) return false
  seen[file] = mtime
  return true
}

async function pickDatabase($: EngineInterface) {
  const list: SqlServer[] = (await read($, servers)) ?? []
  const id = await read($, server)
  const dbs = await databasesOf($, list.find(s => s.id === id))
  const db = await read($, database)
  if (dbs.length && !dbs.includes(db)) await update($, database, () => dbs[0]!)
}

// The session file may name a server by its display name (older files): match it to an id.
async function resolveServer($: EngineInterface) {
  const list = (await read($, servers)) ?? []
  const cur = await read($, server)
  if (!list.length || list.some(s => s.id === cur)) return
  const byName = list.find(s => s.name === cur)
  await update($, server, () => (byName ?? list[0]!).id)
}

async function sync($: EngineInterface) {
  if (!sessionFile) return
  if (await changed($, configFile)) {
    const list = await readServers($)
    await rememberProduction($, list)
    await update($, servers, () => list.map(s => ({ id: s.id, name: s.name, host: s.host, ...(s.tag ? { tag: s.tag } : {}), databases: s.databases ?? [] })))
    const cur = await read($, server)
    if (list.length && !list.some(s => s.id === cur)) {
      const byName = list.find(s => s.name === cur)
      await update($, server, () => (byName ?? list[0]!).id)
    }
    await pickDatabase($)
  }
  // Changed by mtime or, within one mtime tick, by content; the pane's own last write is not a change.
  const moved = await changed($, sessionFile)
  const raw = moved || seenText[sessionFile] !== undefined ? await $.fs.read(sessionFile).catch(() => undefined) : undefined
  if (raw !== undefined && raw !== seenText[sessionFile]) {
    seenText[sessionFile] = raw
    // A prompt answers for the statement it shows; any outside change to the console cancels it.
    if (await read($, confirm)) await update($, confirm, () => null)
    let st: any
    try {
      st = raw === undefined ? undefined : JSON.parse(raw)
    } catch {
      st = undefined
    }
    if (st) {
      if (typeof st.query === 'string' && st.query !== (await read($, query))) {
        await update($, query, () => st.query)
        await update($, rev, n => n + 1)
      }
      if (typeof st.server === 'string' && st.server && st.server !== (await read($, server))) await update($, server, () => st.server)
      if (typeof st.database === 'string' && st.database && st.database !== (await read($, database))) await update($, database, () => st.database)
      if (typeof st.cursorRow === 'number' && st.cursorRow !== (await read($, cursorRow))) {
        await update($, cursorRow, () => st.cursorRow)
        await update($, rev, n => n + 1)
      }
      await pickDatabase($)
    }
  }
  await resolveServer($)
  if (await changed($, schemaFile())) {
    const data = (await readJson($, schemaFile())) ?? {}
    const map: Record<string, SqlSchema> = {}
    for (const [key, entry] of Object.entries(data as Record<string, any>)) {
      if (entry && Array.isArray(entry.dbs)) map[key] = { dbs: entry.dbs, tables: entry.tables ?? {}, cols: entry.cols ?? {} }
    }
    await update($, schema, () => map)
  }
  if (await changed($, resultFile())) {
    const data = await readJson($, resultFile())
    const cur = await read($, result)
    if (data && Array.isArray(data.columns) && data.at !== cur?.at) {
      const next: SqlResult = {
        id: Date.now(),
        server: String(data.server ?? ''),
        database: String(data.database ?? ''),
        sql: String(data.sql ?? ''),
        columns: data.columns.map(String),
        rows: Array.isArray(data.rows) ? data.rows.map((r: unknown) => (Array.isArray(r) ? r.map(String) : [String(r)])) : [],
        ms: Number(data.ms ?? 0),
        ...(data.error ? { error: String(data.error) } : {}),
        ...(data.limited ? { limited: true } : {}),
        at: String(data.at ?? ''),
      }
      await update($, result, () => next)
      await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
    }
  }
}

async function ensureBase($: EngineInterface) {
  // HOME on macOS / Linux; USERPROFILE on Windows.
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  base = `${home}/.claude/mods/sql`
  if (!(await $.fs.exists(`${base}/servers.json`))) await $.fs.write(`${base}/servers.json`, JSON.stringify(DEFAULT_SERVERS, null, 2) + '\n')
}

// Points this session's console at a session file and a config file, creating the session file.
// Answers why it could not, or undefined.
async function attach($: EngineInterface, file?: string, config?: string): Promise<string | undefined> {
  await ensureBase($)
  const kept = await read($, paths)
  const nextConfig = config ? await resolvePath($, config, base) : kept?.config ?? `${base}/servers.json`
  const nextFile = file ? await resolvePath($, file.endsWith('.json') ? file : `${file}.json`, `${base}/sessions`) : kept?.file ?? `${base}/sessions/default.json`
  if (!(await $.fs.exists(nextConfig))) return `Config file not found: ${nextConfig}`
  if (!(await $.fs.exists(nextFile))) {
    const first = (await readJson($, nextConfig))?.servers?.[0]
    await $.fs.write(
      nextFile,
      JSON.stringify({ server: first?.id ?? first?.name ?? '', database: first?.databases?.[0] ?? '', cursorRow: 1, query: DEFAULT_CONSOLE }, null, 2) + '\n',
    )
  }
  if (nextFile !== sessionFile || nextConfig !== configFile) {
    // A save still pending for the old console lands there now, never in the new one.
    if (saveTimer) {
      saveTimer.cancel()
      saveTimer = undefined
      await saveSession($).catch(() => undefined)
    }
    sessionFile = nextFile
    configFile = nextConfig
    for (const k of Object.keys(seen)) delete seen[k]
    for (const k of Object.keys(seenText)) delete seenText[k]
    await update($, paths, () => ({ file: nextFile, config: nextConfig }))
    await update($, result, () => null)
    await update($, view, () => EMPTY_VIEW)
  }
  await sync($)
  return undefined
}

// One save at a time: two overlapping saves would each take the other's write for an outside one.
// Never call saveSession from anything a save runs (sync, pickDatabase, resolveServer): it would wait
// on itself. A failed save tells the person, since nothing else would.
let saving: Promise<void> = Promise.resolve()
let badJson = ''
function saveSession($: EngineInterface, extra: Record<string, unknown> = {}, file = sessionFile): Promise<void> {
  const run = saving.then(() => saveSessionNow($, extra, file))
  saving = run.catch(err => $.ui.toast(`Not saved: ${file}: ${String(err).slice(0, 160)}`))
  return run
}

async function saveSessionNow($: EngineInterface, extra: Record<string, unknown>, file: string) {
  if (!file) return
  // Someone else (the agent, another editor) wrote the file since this pane last read or wrote it:
  // their editor fields win, only `extra` (a run's lastRun, a menu pick) is merged in, and the pane
  // reloads them. The mtime is read before the text, so a write in between counts as theirs.
  const mtime = await $.fs.stat(file).then(s => s.mtimeMs, () => undefined)
  const raw = await $.fs.read(file).catch(() => undefined)
  let old: Record<string, unknown> = {}
  try {
    old = raw === undefined ? {} : (JSON.parse(raw) ?? {})
  } catch {
    // A hand edit with a JSON typo is never replaced by the pane's state; said once per broken version.
    if (badJson !== raw) $.ui.toast(`Not saved: ${file} is not valid JSON. Fix it, or delete it to start over.`)
    badJson = raw ?? ''
    return
  }
  const external =
    file !== sessionFile ||
    (mtime !== undefined && seen[file] !== undefined && mtime !== seen[file]) ||
    (raw !== undefined && seenText[file] !== undefined && raw !== seenText[file])
  const mine = external
    ? {}
    : { server: await read($, server), database: await read($, database), cursorRow: await read($, cursorRow), query: await read($, query) }
  await write($, file, JSON.stringify({ ...old, ...mine, ...extra }, null, 2) + '\n')
  if (external && file === sessionFile) {
    delete seen[file]
    delete seenText[file]
    await sync($)
  }
}

function scheduleSave($: EngineInterface) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(250, () => void saveSession($).catch(() => undefined))
}

// ---- running ----

async function mysqlBinary($: EngineInterface, s: DbServer): Promise<string> {
  if (s.mysqlPath) return s.mysqlPath
  for (const p of MYSQL_CANDIDATES) if (await $.fs.exists(p)) return p
  return 'mysql'
}

// Runs one statement that already passed readGuard. The guard runs again here so no caller can skip it.
async function runSql($: EngineInterface, creds: DbServer, db: string, sql: string, mode: 'read' | 'write' = 'read'): Promise<{ columns: string[]; rows: string[][]; ms: number; error?: string; limited?: boolean }> {
  // The guard runs again here so no caller can skip it: reads must pass readGuard, writes must be
  // a plain INSERT / UPDATE / DELETE that the person approved (mode 'write' only comes from there).
  const c = classifyStatement(sql, db)
  if (mode === 'read' && c.kind !== 'read') return { columns: [], rows: [], ms: 0, error: c.kind === 'refused' ? c.reason : readGuard(sql)! }
  if (mode === 'write' && c.kind !== 'write') return { columns: [], rows: [], ms: 0, error: c.kind === 'refused' ? c.reason : 'Not sent: not a write.' }
  if (!creds.host) return { columns: [], rows: [], ms: 0, error: `Server "${creds.name}" has no host. Fill it in ${configFile}.` }
  const started = Date.now()
  const { argv, env } = mysqlInvocation(creds, db || undefined, await mysqlBinary($, creds))
  try {
    const out = await $.process.run(argv, { stdin: mode === 'write' ? mysqlWriteScript(sql) : mysqlScript(sql, creds), env, timeoutMs: ((creds.timeoutSec ?? 60) + 15) * 1000 })
    const ms = Date.now() - started
    const stderr = out.stderr
      .split('\n')
      .filter(l => l.trim() && !/Using a password on the command line|Deprecated program name/i.test(l))
      .join('\n')
    if (out.exitCode !== 0) return { columns: [], rows: [], ms, error: stderr || `mysql exited ${out.exitCode}` }
    const parsed = parseBatch(out.stdout)
    const maxRows = Math.max(1, Math.min(100_000, creds.maxRows ?? 1000))
    return { ...parsed, ms, ...(parsed.rows.length >= maxRows ? { limited: true } : {}) }
  } catch (err) {
    return { columns: [], rows: [], ms: Date.now() - started, error: String(err) }
  }
}

async function isProduction($: EngineInterface, s: DbServer): Promise<boolean> {
  const seen = [...((await read($, prodSeen)) ?? []), ...(((await $.store.get('prodSeen')) as string[] | undefined) ?? [])]
  return s.tag === 'production' || seen.includes(`id:${s.id}`) || seen.includes(`host:${s.host}:${s.port ?? 3306}`)
}

async function rememberProduction($: EngineInterface, list: DbServer[]) {
  const marks = list.filter(s => s.tag === 'production').flatMap(s => [`id:${s.id}`, `host:${s.host}:${s.port ?? 3306}`])
  if (!marks.length) return
  await update($, prodSeen, seen => [...new Set([...(seen ?? []), ...marks])])
  const kept = ((await $.store.get('prodSeen')) as string[] | undefined) ?? []
  const next = [...new Set([...kept, ...marks])]
  if (next.length !== kept.length) await $.store.set('prodSeen', next.slice(-20000))
}

// A session unlock counts only for the server entry it was given to, unchanged, and never on production.
async function isUnlockedNow($: EngineInterface, s: DbServer): Promise<boolean> {
  if (await isProduction($, s)) return false
  const fp = credentialFingerprint(s)
  return ((await read($, unlocked)) ?? []).some(u => u.id === s.id && u.fingerprint === fp)
}

const targetLabel = (s: DbServer) => `${s.host}:${s.port ?? 3306}${s.https ? ' (TLS)' : ''}`

async function run($: EngineInterface) {
  if (await read($, running)) return
  const text = await read($, query)
  const stmt = statementAt(text, await read($, cursorRow))
  if (!stmt) return $.ui.toast('No statement in the console.')
  const name = await read($, server)
  const db = await read($, database)
  const target = (await readServers($)).find(s => s.id === name)
  if (!target) return $.ui.toast(`No server "${name}" in ${configFile}`)
  const c = classifyStatement(stmt.sql, db)
  if (c.kind === 'refused') return record($, target, db, stmt.sql, { columns: [], rows: [], ms: 0, error: c.reason })
  if (c.kind === 'write' && !(await isUnlockedNow($, target))) {
    // Writes are locked: the person approves this exact statement, or unlocks the server for the session.
    await update($, menuOpen, () => '')
    const prompt: SqlWritePrompt = {
      kind: 'write', serverId: target.id, serverName: target.name, target: targetLabel(target), fingerprint: credentialFingerprint(target),
      database: db, sql: stmt.sql, verb: c.verb, noWhere: c.noWhere, calls: c.calls, ddl: c.ddl, production: await isProduction($, target), shownFrom: 0,
    }
    await update($, confirm, () => prompt)
    return
  }
  await sendStatement($, target, db, stmt.sql, c.kind === 'write' ? 'write' : 'read')
}

// Runs exactly this statement: the server entry must be unchanged and its credentials approved.
async function sendStatement($: EngineInterface, target: DbServer, db: string, sql: string, mode: 'read' | 'write', fingerprint?: string) {
  if (fingerprint && credentialFingerprint(target) !== fingerprint) return $.ui.toast(`Not run: server "${target.name}" changed in ${configFile}. Run it again.`)
  if (!(await isTrusted($, target))) {
    await update($, confirm, () => ({ kind: 'trust' as const, serverId: target.id, serverName: target.name, target: targetLabel(target), source: credentialSource(target)!, fingerprint: credentialFingerprint(target), then: 'run' as const, sql, database: db, mode }))
    return
  }
  await runStatement($, target, db, sql, mode)
}

// Runs one statement on a trusted server and records the result. The guard runs again in runSql.
async function runStatement($: EngineInterface, target: DbServer, db: string, sql: string, mode: 'read' | 'write' = 'read') {
  const stmt = { sql }
  // The console this statement belongs to: a switch to another session file meanwhile doesn't move it.
  const at = { file: sessionFile, result: resultFile() }
  await update($, running, () => true)
  const out = await withPassword($, target)
    .then(creds => runSql($, creds, db, stmt.sql, mode))
    .catch(err => ({ columns: [] as string[], rows: [] as string[][], ms: 0, error: String(err) }))
  await record($, target, db, stmt.sql, out, at)
}

async function record($: EngineInterface, target: DbServer, db: string, sql: string, out: { columns: string[]; rows: string[][]; ms: number; error?: string; limited?: boolean }, at = { file: sessionFile, result: resultFile() }) {
  const name = target.id
  const next: SqlResult = { id: Date.now(), server: target.name, database: db, sql, ...out, at: new Date().toISOString() }
  await update($, running, () => false)
  if (at.file === sessionFile) {
    await update($, result, () => next)
    await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
  }
  const { id: _i, ...file } = next
  await write($, at.result, JSON.stringify({ ...file, rowCount: next.rows.length }, null, 2) + '\n')
  await saveSession($, { lastRun: { server: name, database: db, ms: next.ms, rows: next.rows.length, ...(next.error ? { error: next.error.slice(0, 500) } : {}), at: next.at } }, at.file)
  if (next.error) $.ui.toast(next.error.startsWith('Read-only') || next.error.startsWith('Not sent') ? 'Not sent: see the result pane' : `SQL: ${next.error.slice(0, 160)}`)
}

// Reads table and column names for the server's databases into schema.json (SELECT only).
async function refreshSchema($: EngineInterface, name: string) {
  if ((await read($, schemaLoading)) === name) return
  const target = (await readServers($)).find(s => s.id === name)
  if (!target || !target.host) return
  if (!(await isTrusted($, target))) {
    await update($, confirm, () => ({ kind: 'trust' as const, serverId: target.id, serverName: target.name, target: targetLabel(target), source: credentialSource(target)!, fingerprint: credentialFingerprint(target), then: 'schema' as const, sql: '', database: '', mode: 'read' as const }))
    return
  }
  await update($, schemaLoading, () => name)
  try {
    const creds = await withPassword($, target)
    let dbs = Array.isArray(creds.databases) ? creds.databases.map(String) : []
    if (!dbs.length) {
      const shown = await runSql($, creds, '', 'SHOW DATABASES')
      if (shown.error) throw new Error(shown.error)
      dbs = shown.rows.map(r => r[0]!).filter(d => !/^(information_schema|performance_schema|mysql|sys)$/.test(d))
    }
    const out = await runSql($, { ...creds, maxRows: 100_000 }, '', schemaQuery(dbs))
    if (out.error) throw new Error(out.error)
    const tables: Record<string, string[]> = {}
    const cols: Record<string, string[]> = {}
    for (const [db, table, col] of out.rows) {
      if (!db || !table || !col) continue
      const list = (tables[db] ??= [])
      if (list[list.length - 1] !== table) list.push(table)
      ;(cols[`${db}.${table}`] ??= []).push(col)
    }
    const entry: SqlSchema = { dbs, tables, cols }
    const data = (await readJson($, schemaFile())) ?? {}
    data[serverKey(creds)] = { ...entry, at: new Date().toISOString() }
    await write($, schemaFile(), JSON.stringify(data) + '\n')
    await update($, schema, m => ({ ...(m ?? {}), [serverKey(creds)]: entry }))
    await pickDatabase($)
    $.ui.toast(`${target.name}: ${Object.values(tables).reduce((n, t) => n + t.length, 0)} tables loaded`)
  } catch (err) {
    $.ui.toast(`${target.name}: could not read the schema (${String(err).slice(0, 140)})`)
  } finally {
    await update($, schemaLoading, () => '')
  }
}

async function ensureSchema($: EngineInterface) {
  const name = await read($, server)
  const s = ((await read($, servers)) ?? []).find(x => x.id === name)
  const full = s ? (await readServers($)).find(x => x.id === s.id) : undefined
  // Loads names only for a server whose credentials the person approved; it never prompts.
  if (s && full && s.host && !(await read($, schema))?.[serverKey(s)] && (await isTrusted($, full))) await refreshSchema($, name)
}

// What the editor's autocomplete gets for the current server and database, kept under the props bound.
function schemaProps(sc: SqlSchema | undefined, db: string) {
  if (!sc) return undefined
  let budget = 70_000
  const tables: Record<string, string[]> = {}
  const cols: Record<string, string[]> = {}
  const order = [db, ...sc.dbs.filter(d => d !== db)]
  for (const d of order) {
    const list = sc.tables[d] ?? []
    budget -= list.reduce((n, t) => n + t.length + 3, 0)
    if (budget < 0) break
    tables[d] = list
  }
  for (const d of order) {
    for (const t of tables[d] ?? []) {
      const c = sc.cols[`${d}.${t}`] ?? []
      const cost = c.reduce((n, x) => n + x.length + 3, t.length + d.length + 6)
      if (budget - cost < 0) continue
      budget -= cost
      cols[`${d}.${t}`] = c
    }
  }
  return { db, dbs: sc.dbs, tables, cols }
}

async function viewerKey($: EngineInterface, key: string, ctrl: boolean, meta: boolean, shift: boolean) {
  if (key === '/' || ((ctrl || meta) && key === 'f')) {
    await $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)
    return
  }
  if (key === 'y' || key === 'J') {
    const r = await read($, result)
    if (!r) return
    const text = key === 'y' ? toTsv(r.columns, r.rows) : JSON.stringify(r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i] === 'NULL' ? null : row[i]]))), null, 2)
    const copied = { isCopied: await copyText($, text) }
    $.ui.toast(copied.isCopied ? `Copied ${r.rows.length} rows as ${key === 'y' ? 'TSV' : 'JSON'}` : 'Copy failed')
    return
  }
  await editView($, (v, r) => {
    const lines = linesOf(r, v)
    const cur = lines[v.cursor]
    const step = shift ? 40 : 8
    const toggle = (row: number, open?: boolean) => {
      const isOpen = v.expanded.includes(row)
      const want = open ?? !isOpen
      const expanded = want ? (isOpen ? v.expanded : [...v.expanded, row]) : v.expanded.filter(x => x !== row)
      const after = linesOf(r, { ...v, expanded })
      return { ...v, expanded, cursor: Math.max(0, after.findIndex(l => l.path === `r${row}`)) }
    }
    switch (key) {
      case 'up':
      case 'k':
        return { ...v, cursor: v.cursor - 1 }
      case 'down':
      case 'j':
        return { ...v, cursor: v.cursor + 1 }
      case 'pageup':
        return { ...v, cursor: v.cursor - viewerHeight, top: v.top - viewerHeight }
      case 'pagedown':
        return { ...v, cursor: v.cursor + viewerHeight, top: v.top + viewerHeight }
      case 'home':
      case 'g':
        return { ...v, cursor: 0, top: 0, left: 0 }
      case 'end':
      case 'G':
        return { ...v, cursor: lines.length - 1 }
      case 'left':
      case 'h':
        return { ...v, left: v.left - step }
      case 'right':
      case 'l':
        return { ...v, left: v.left + step }
      case 'return':
      case 'enter':
      case 'space':
      case ' ': {
        const row = cur ? rowOf(cur.path) : undefined
        return row === undefined ? v : toggle(row)
      }
      case 'e':
        return { ...v, expanded: r.rows.map((_, i) => i).slice(0, 500) }
      case 'c':
        return { ...v, expanded: [], cursor: 0, top: 0 }
      case 'n':
        return jump(r, v, v.match + 1)
      case 'N':
        return jump(r, v, v.match - 1)
    }
    return v
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sql',
      description: 'Toggle the SQL console pane (writes locked by default)',
      argumentHint: '[--filepath <session>.json] [--configfilepath <servers>.json]',
    })
    await $.tool.register({
      name: 'console',
      description: GUIDE,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'close', 'status'], description: 'open (default) attaches and shows the pane; close hides it; status only reports the files' },
          filepath: { type: 'string', description: 'Session file for this console (own state per session/agent). Relative = under ~/.claude/mods/sql/sessions/; .json added if missing; created when new.' },
          configfilepath: { type: 'string', description: 'Servers config file (hosts, users, databases). Relative = under ~/.claude/mods/sql/. Must exist.' },
        },
      },
    })
    const kept = await read($, paths)
    // A broken file must not stop the watcher for the whole session.
    await attach($, kept?.file, kept?.config).catch(() => undefined)
    $.clock.every(600, () => void sync($).catch(() => undefined))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__mysql-client__console' }, async ($, e) => {
    // A plugin tool's arguments arrive on the event itself, beside `tool` and `tool_use_id`.
    const input = e as unknown as { action?: string; filepath?: string; configfilepath?: string }
    const action = input.action ?? 'open'
    if (action === 'close') {
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
      return { result: 'SQL console closed.' }
    }
    // An agent's console files stay inside the mod's folder: other paths are the person's call
    // (/sql --filepath … --configfilepath …).
    if (!base) await ensureBase($)
    const inside = async (p: string | undefined, under: string, root: string) => {
      if (!p) return true
      const want = await resolvePath($, p.endsWith('.json') || under === base ? p : `${p}.json`, under)
      const real = (await $.fs.stat(want, { resolve: true }).catch(() => undefined))?.realPath ?? want
      const top = (await $.fs.stat(root, { resolve: true }).catch(() => undefined))?.realPath ?? root
      return !/(^|\/)\.\.(\/|$)/.test(want) && real.startsWith(top + '/')
    }
    if (!(await inside(input.filepath, `${base}/sessions`, base))) return { result: `filepath must be inside ${base}/sessions/. Ask the user to open other files with /sql --filepath.`, isError: true }
    if (!(await inside(input.configfilepath, base, base)) || (input.configfilepath && (await inside(input.configfilepath, base, `${base}/sessions`)))) {
      return { result: `configfilepath must be inside ${base}/ (not sessions/). Ask the user to open other configs with /sql --configfilepath.`, isError: true }
    }
    const refused = await attach($, input.filepath, input.configfilepath)
    if (refused) return { result: refused, isError: true }
    let placed = ''
    if (action === 'open') {
      const opened = await $.ui.open({ id: PANE, title: `SQL · ${sessionFile.split('/').pop()}` })
      placed = opened.isPlaced ? 'Pane is open. ' : `Pane not shown yet (${(opened as any).reason ?? 'terminal too narrow'}); the user can type /sql. `
    }
    return { result: `${placed}Session file: ${sessionFile}\nResult file: ${resultFile()}\nConfig file: ${configFile}` }
  })

  on('command.run', { command: 'sql' }, async ($, e) => {
    const args = parseArgs(e.args ?? '')
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen && !args.file && !args.config) {
      await $.ui.close({ id: PANE })
      return { text: 'SQL console closed.' }
    }
    const refused = await attach($, args.file, args.config)
    if (refused) return { text: refused }
    await $.ui.open({ id: PANE, title: `SQL · ${sessionFile.split('/').pop()}`, focus: true, columns: 120 })
    void ensureSchema($).catch(() => undefined)
    return {
      text: `SQL console opened: ${sessionFile}`,
      context: [`${GUIDE}\n\nThis session's console: session file ${sessionFile}, result file ${resultFile()}, config file ${configFile}.`],
    }
  })

  // The wheel scrolls whichever half the pointer is over; the pane itself never moves.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const row = e.pointer?.row
    if (row === undefined) return {}
    const by = Math.sign(e.by) * Math.max(1, Math.min(10, Math.abs(e.by) * 3))
    if (row < editorBottom) {
      await update($, editorScroll, () => ({ id: Date.now(), by }))
    } else {
      await editView($, v => {
        const top = Math.max(0, v.top + by)
        const cursor = Math.min(Math.max(v.cursor, top), top + viewerHeight - 1)
        return { ...v, top, cursor }
      })
    }
    return {}
  })

  on('ui.message', async ($, e) => {
    const data = (e.data ?? {}) as Record<string, any>
    if (e.element === 'editor') {
      if (data.type !== 'run' && data.type !== 'copy' && (await read($, confirm))) await update($, confirm, () => null)
      if (typeof data.text === 'string') await update($, query, () => data.text)
      if (typeof data.row === 'number') await update($, cursorRow, () => data.row)
      // A cut carries its text on the edit post; a copy has its own.
      if (typeof data.copy === 'string') $.ui.toast((await copyText($, data.copy)) ? (data.auto ? `Copied ${data.copy.length} characters` : 'Copied') : 'Copy failed')
      if (data.type === 'copy') {
        // nothing more: the text and cursor were taken above
      } else if (data.type === 'paste') {
        for (const argv of PASTE_COMMANDS) {
          const out = await $.process.run(argv).catch(() => undefined)
          if (out && out.exitCode === 0) {
            await update($, paste, () => ({ id: Date.now(), text: out.stdout.replace(/\r\n/g, '\n') }))
            break
          }
        }
      } else if (data.type === 'run') {
        scheduleSave($)
        await run($)
      } else if (data.type === 'format') {
        await update($, query, t => formatSql(t, [...KEYWORDS, ...FUNCTIONS]))
        await update($, rev, n => n + 1)
        scheduleSave($)
      } else {
        scheduleSave($)
      }
    } else if (e.element === 'viewer') {
      if (data.type === 'click') {
        await editView($, (v, r) => {
          const idx = v.top + Number(data.y)
          const l = linesOf(r, v)[idx]
          const row = l ? rowOf(l.path) : undefined
          if (row === undefined) return { ...v, cursor: idx }
          const expanded = v.expanded.includes(row) ? v.expanded.filter(x => x !== row) : [...v.expanded, row]
          return { ...v, expanded, cursor: idx }
        })
      } else if (data.type === 'pan') {
        const by = Number(data.by)
        if (Number.isFinite(by)) await editView($, v => ({ ...v, left: Math.max(0, v.left + Math.round(by)) }))
      } else if (data.type === 'key') {
        await viewerKey($, String(data.key), !!data.ctrl, !!data.meta, !!data.shift)
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Client, Markdown } = $.ui.resolve(e) as any
    // The pane's own rows (the terminal's height is larger: transcript, prompt and footer share it).
    const knownRows: number | undefined = (e.props as any).scroll?.bodyRows
    const rows = knownRows ?? e.viewport?.rows ?? 36
    const text = await read($, query)
    const r = await read($, result)
    const v = (await read($, view)) ?? EMPTY_VIEW
    const isRunning = await read($, running)
    const current = await read($, server)
    const db = await read($, database)
    const list: SqlServer[] = (await read($, servers)) ?? []
    const row = await read($, cursorRow)
    const stmt = statementAt(text, row)
    const target = list.find(s => s.id === current)
    const menu = await read($, menuOpen)
    const ask = await read($, confirm)
    const cmd = await read($, editorCmd)
    const help = await read($, showHelp)
    const pasted = await read($, paste)
    const scrolled = await read($, editorScroll)
    const loading = (await read($, schemaLoading)) === current
    const sc = target ? ((await read($, schema)) ?? {})[serverKey(target)] : undefined
    const knownCols: number | undefined = (e.props as any).bodyColumns
    const cols = knownCols ?? 100
    const targetFull = target ? (await readServers($)).find(x => x.id === target.id) : undefined
    const isProd = !!targetFull && (await isProduction($, targetFull))
    const isUnlocked = !!targetFull && (await isUnlockedNow($, targetFull))
    const isWritePrompt = ask?.kind === 'write'
    // A write prompt takes the whole pane. It draws ASCII only, counts every row from the pane's
    // real size, and shows the statement forward from the furthest point already shown; the run
    // buttons appear only once its end has been on screen.
    const promptWidth = Math.max(10, cols - 4)
    const sqlView = ask?.kind === 'write' ? asciiView(ask.sql) : ''
    // Toolbar and info line (2), the prompt's frame (2), title, target, statement header, hint and
    // buttons (5), plus the warning lines it shows.
    const chrome = 9 + (ask?.kind === 'write' && ask.noWhere ? 1 : 0) + (ask?.kind === 'write' && ask.calls.length ? 1 : 0) + (ask?.kind === 'write' && ask.ddl ? 1 : 0)
    const pageSize = rows - chrome
    const tooLong = sqlView.length > SQL_LIMIT
    // An unknown pane size can't be checked, so it counts as too small: no run buttons.
    const tooSmall = isWritePrompt && (knownRows === undefined || knownCols === undefined || pageSize < 3)
    const shown = ask?.kind === 'write' && !tooLong && !tooSmall ? pageFrom(sqlView, ask.shownFrom, promptWidth, pageSize) : { rows: [] as string[], end: sqlView.length }
    const sqlSeen = isWritePrompt && !tooLong && !tooSmall && shown.end >= sqlView.length
    const dbList = target ? (target.databases.length ? target.databases : sc?.dbs ?? []) : []

    const fixed = 11
    // An open menu sits under the toolbar; the editor gives up its rows.
    const menuRows = (menu === 'server' ? Math.max(1, list.length) + 2 : menu === 'db' ? Math.max(1, dbList.length) + 2 : 0) + (ask?.kind === 'trust' ? 6 : 0)
    const editorHeight = Math.max(3, Math.floor((rows - fixed) * 0.4) - menuRows)
    viewerHeight = Math.max(4, rows - fixed - editorHeight)
    viewerWidth = Math.max(20, cols - 4)
    editorBottom = 2 + menuRows + editorHeight

    let viewerProps: { lines: [string, string][][]; cursor: number; height: number; status: string }
    if (!r) {
      viewerProps = { lines: [[['  ', 'f'], ['Click ▶ in the editor gutter (or ctrl+r) to run the statement under the cursor.', 'm']]], cursor: -1, height: viewerHeight, status: '' }
    } else {
      const lines = linesOf(r, v)
      const vv = keepVisible(v, lines.length)
      const found = matchesOf(r, v)
      const currentMatch = found.length ? found[Math.min(v.match, found.length - 1)] : undefined
      const windowLines = lines
        .slice(vv.top, vv.top + viewerHeight)
        .map(l => sliceSegs(highlight(l.segs, v.search, l.path === currentMatch ? 'C' : 'H'), vv.left, viewerWidth) as [string, string][])
      const where = v.search ? (found.length ? ` · match ${Math.min(v.match, found.length - 1) + 1}/${found.length}` : ' · no matches') : ''
      viewerProps = {
        lines: windowLines,
        cursor: vv.cursor - vv.top,
        height: viewerHeight,
        status: `${r.rows.length} rows${r.limited ? ' (row limit)' : ''}${where} · ↑↓ ⏎ open row · ←→ columns · y TSV · J JSON · / find`,
      }
    }

    const status = isRunning
      ? 'running…'
      : r
        ? r.error
          ? `error · ${r.ms} ms · ${r.server}/${r.database}`
          : `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.limited ? ' (row limit)' : ''} · ${r.ms} ms · ${r.server}/${r.database}`
        : 'no result yet'
    const statusColor = !r ? undefined : r.error ? 'error' : 'success'
    const firstLine = stmt ? stmt.sql.split('\n')[0]!.slice(0, 80) : 'no statement'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} height={1}>
          <Button key="server-menu" label={`▾ ${target ? target.name : 'Choose server'}`} variant="primary" onPress={() => void (isWritePrompt ? $.ui.toast('Finish or cancel the write prompt first.') : update($, menuOpen, m => (m === 'server' ? '' : 'server')))} />
          <Button key="db-menu" label={`▾ ${db || 'Database'}`} onPress={() => void (isWritePrompt ? $.ui.toast('Finish or cancel the write prompt first.') : update($, menuOpen, m => (m === 'db' ? '' : 'db')))} />
          <Button
            key="lock"
            label={isUnlocked ? '🔓 writes on' : '🔒 writes locked'}
            onPress={() =>
              void (async () => {
                if (!targetFull) return
                if (isUnlocked) {
                  await update($, unlocked, l => (l ?? []).filter(u => u.id !== targetFull.id))
                  $.ui.toast(`${targetFull.name}: writes locked`)
                } else $.ui.toast('Writes unlock from the prompt a write opens, one statement or one session at a time.')
              })().catch(() => undefined)
            }
          />
          <Button key="undo" label="↶" onPress={() => void update($, editorCmd, () => ({ id: Date.now(), cmd: 'undo' }))} />
          <Button key="redo" label="↷" onPress={() => void update($, editorCmd, () => ({ id: Date.now(), cmd: 'redo' }))} />
          <Text dimColor>│</Text>
          <Button
            key="format"
            label="Format"
            onPress={() =>
              void (async () => {
                await update($, query, t => formatSql(t, [...KEYWORDS, ...FUNCTIONS]))
                await update($, rev, n => n + 1)
                scheduleSave($)
              })()
            }
          />
          <Button key="schema" label={loading ? '… Schema' : '↻ Schema'} onPress={() => void refreshSchema($, current)} />
          <Button key="help" label={help ? 'Close help' : 'Help'} onPress={() => void update($, showHelp, h => !h)} />
        </Box>
        <Text wrap="truncate-end">
          <Text dimColor>{firstLine} → </Text>
          <Text color={tagColor(target?.tag)} bold={isProd ? true : undefined}>
            {target ? `${target.name}/${db || '(no database)'}${target.tag ? ` · ${target.tag}` : ''}${isUnlocked ? ' · writes on' : ''}` : '(no server)'}
          </Text>
          {target && !target.host ? <Text color="warning">{` · fill in host and user in ${configFile}`}</Text> : null}
        </Text>
        {ask?.kind === 'trust' ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#d7a700" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="warning" wrap="truncate-end">{`Connect to ${asciiView(ask.serverName)} with these credentials?`}</Text>
            <Text wrap="wrap">{asciiView(`${ask.target} gets ${ask.source}.`)}</Text>
            <Text dimColor>Asked once per server, and again whenever its host or credential source changes in the config.</Text>
            <Box flexDirection="row" gap={2} height={1}>
              <Button
                key="trust-yes"
                label="Allow"
                variant="primary"
                onPress={() =>
                  void (async () => {
                    const a = ask
                    if (a.kind !== 'trust') return
                    const now = await read($, confirm)
                    if (!now || JSON.stringify(now) !== JSON.stringify(a)) return $.ui.toast('That prompt was cancelled; nothing ran.')
                    await update($, confirm, () => null)
                    const target = (await readServers($)).find(s => s.id === a.serverId)
                    if (!target || credentialFingerprint(target) !== a.fingerprint) return $.ui.toast(`Not run: server "${a.serverName}" changed. Run it again.`)
                    await trust($, a.fingerprint)
                    if (a.then === 'run') await runStatement($, target, a.database, a.sql, a.mode)
                    else await refreshSchema($, a.serverId)
                  })().catch(() => undefined)
                }
              />
              <Button key="trust-no" label="Cancel" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        {ask?.kind === 'write' ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#f14c4c" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="error" wrap="truncate-end">{`Writes are locked for ${asciiView(ask.serverName)}`}</Text>
            <Text wrap="truncate-end">{asciiView(`${ask.verb} on ${ask.target} / ${ask.database || '(no database)'}${ask.production ? ' · production' : ''}`)}</Text>
            {ask.noWhere ? <Text bold color="error" wrap="truncate-end">{`No WHERE clause: this ${ask.verb === 'DELETE' ? 'deletes' : 'changes'} every row of the table.`}</Text> : null}
            {ask.ddl ? <Text bold color="error" wrap="truncate-end">{ask.verb === 'CALL' ? 'A procedure may commit or change the schema itself: it may not roll back.' : `${ask.verb} commits at once: it can't be rolled back.`}</Text> : null}
            {ask.calls.length ? <Text color="warning" wrap="truncate-end">{asciiView(`Calls ${ask.calls.map(c => `${c}()`).join(', ')}: a stored function can change more than this statement shows.`)}</Text> : null}
            {tooLong ? (
              <Text color="error" wrap="truncate-end">{`statement: ${sqlView.length} characters, too long to review here, so it can't be run from the console.`}</Text>
            ) : tooSmall ? (
              <Text color="error" wrap="truncate-end">Make the pane taller to review this statement.</Text>
            ) : (
              <Box flexDirection="column">
                <Text dimColor wrap="truncate-end">{`statement as sent (${sqlView.length} characters, shown up to ${Math.floor((shown.end / Math.max(1, sqlView.length)) * 100)}%):`}</Text>
                {shown.rows.map(l => (
                  <Text wrap="truncate-end">{l || ' '}</Text>
                ))}
              </Box>
            )}
            <Text dimColor wrap="truncate-end">{sqlSeen ? (ask.ddl ? 'Run sends exactly this statement.' : 'Run sends exactly this statement, in one transaction.') : tooLong ? 'Cancel, and split it into smaller statements.' : tooSmall ? 'Enlarge the pane, or cancel.' : 'Read the whole statement before you can run it.'}</Text>
            <Box flexDirection="row" gap={2} height={1}>
              {!sqlSeen && !tooLong && !tooSmall ? (
                <Button
                  key="sql-next"
                  label="Next page"
                  variant="primary"
                  onPress={() => {
                    // Moves on from what this drawing showed; a stale press (another prompt by now) does nothing.
                    const same = JSON.stringify({ ...ask, shownFrom: 0 })
                    const from = ask.shownFrom
                    const to = shown.end
                    void update($, confirm, c => (c && c.kind === 'write' && JSON.stringify({ ...c, shownFrom: 0 }) === same && c.shownFrom === from ? { ...c, shownFrom: to } : c))
                  }}
                />
              ) : null}
              {sqlSeen ? (
                <Button
                  key="write-once"
                  label="Run this statement once"
                  variant="primary"
                  onPress={() =>
                    void (async () => {
                      const a = ask
                      // Acts only on the prompt this drawing showed; one cancelled or replaced since does nothing.
                      const now = await read($, confirm)
                      if (!now || JSON.stringify(now) !== JSON.stringify(a)) return $.ui.toast('That prompt was cancelled; nothing ran.')
                      await update($, confirm, () => null)
                      const t = (await readServers($)).find(x => x.id === a.serverId)
                      if (!t) return $.ui.toast(`Not run: server "${a.serverName}" is gone from ${configFile}.`)
                      await sendStatement($, t, a.database, a.sql, 'write', a.fingerprint)
                    })().catch(() => undefined)
                  }
                />
              ) : null}
              {sqlSeen && !ask.production ? (
                <Button
                  key="write-session"
                  label="Unlock for this session"
                  onPress={() =>
                    void (async () => {
                      const a = ask
                      const now = await read($, confirm)
                      if (!now || JSON.stringify(now) !== JSON.stringify(a)) return $.ui.toast('That prompt was cancelled; nothing ran.')
                      await update($, confirm, () => null)
                      const t = (await readServers($)).find(x => x.id === a.serverId)
                      if (!t || credentialFingerprint(t) !== a.fingerprint) return $.ui.toast(`Not run: server "${a.serverName}" changed in ${configFile}. Run it again.`)
                      if (await isProduction($, t)) return $.ui.toast(`Not run: ${a.serverName} is now tagged production, which gets no session unlock. Run it again to approve it once.`)
                      await update($, unlocked, l => [...(l ?? []).filter(u => u.id !== a.serverId), { id: a.serverId, fingerprint: a.fingerprint } as SqlUnlock])
                      $.ui.toast(`${a.serverName}: writes unlocked until this session ends (🔓 locks again)`)
                      await sendStatement($, t, a.database, a.sql, 'write', a.fingerprint)
                    })().catch(() => undefined)
                  }
                />
              ) : null}
              <Button key="write-cancel" label="Cancel" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        {menu === 'server' && !isWritePrompt ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#4ec9b0" backgroundColor="#1e1e1e" paddingX={1}>
            {list.length === 0 && <Text color="error">no servers in {configFile}</Text>}
            {list.map(sv => (
              <Box flexDirection="row" gap={1} height={1}>
                <Button
                  key={`pick:${sv.id}`}
                  plain
                  label={`${sv.id === current ? '●' : ' '} ${sv.name}`}
                  onPress={() =>
                    void (async () => {
                      await update($, server, () => sv.id)
                      await update($, menuOpen, () => '')
                      await update($, confirm, () => null)
                      await pickDatabase($)
                      // The person's pick wins over a session file someone else just wrote.
                      await saveSession($, { server: sv.id, database: await read($, database) })
                      void ensureSchema($).catch(() => undefined)
                    })()
                  }
                />
                {sv.tag ? <Text color={tagColor(sv.tag)}>{sv.tag}</Text> : null}
                <Text dimColor>{sv.host || '(no host yet)'}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {menu === 'db' && !isWritePrompt ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#4ec9b0" backgroundColor="#1e1e1e" paddingX={1}>
            {dbList.length === 0 && <Text dimColor>No databases yet: press ↻ Schema, or list them under "databases" in servers.json</Text>}
            {dbList.map(d => (
              <Button
                key={`pickdb:${d}`}
                plain
                label={`${d === db ? '●' : ' '} ${d}`}
                onPress={() =>
                  void (async () => {
                    await update($, database, () => d)
                    await update($, menuOpen, () => '')
                    await saveSession($, { database: d })
                  })()
                }
              />
            ))}
          </Box>
        ) : null}
        {isWritePrompt ? null : (<>
        <Client
          key="editor"
          module="./editor.tsx"
          width="100%"
          height={editorHeight}
          props={{
            text,
            rev: await read($, rev),
            height: editorHeight,
            row,
            runRows: parseStatements(text).map(s => s.start),
            ...(pasted ? { paste: pasted } : {}),
            ...(scrolled ? { scroll: scrolled } : {}),
            ...(cmd ? { cmd } : {}),
            ...(sc ? { schema: schemaProps(sc, db) } : {}),
          }}
        />
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(10, cols))}
        </Text>
        <Text color={statusColor} wrap="truncate-end">
          {status}
        </Text>
        <Input
          key="search"
          label="Find "
          placeholder="search the result (/ or ctrl+f from it) · Enter = next"
          value={v.search}
          onInput={(value: string) => void editView($, (vw, rr) => jump(rr, { ...vw, search: value }, 0))}
          onSubmit={(value: string) => void editView($, (vw, rr) => jump(rr, { ...vw, search: value }, vw.search === value ? vw.match + 1 : 0))}
        />
        {help ? (
          <Box flexDirection="column" height={viewerHeight + 1} overflow="hidden">
            <Markdown text={HELP} />
          </Box>
        ) : (
          <Client key="viewer" module="./viewer.tsx" width="100%" height={viewerHeight + 1} props={viewerProps} />
        )}
        </>)}
      </Box>
    )
  })
}
