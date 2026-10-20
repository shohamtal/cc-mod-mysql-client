import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SqlResult, SqlSchema, SqlServer, SqlView } from '../types'
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
  credentialSource,
  credentialFingerprint,
} from './lib'

const PANE = 'sql'
const query = atom({ plugin: 'sql-console', key: 'query' } as const, '')
const rev = atom({ plugin: 'sql-console', key: 'rev' } as const, 0)
const cursorRow = atom({ plugin: 'sql-console', key: 'cursorRow' } as const, 0)
const result = atom({ plugin: 'sql-console', key: 'result' } as const, null)
const running = atom({ plugin: 'sql-console', key: 'running' } as const, false)
const server = atom({ plugin: 'sql-console', key: 'server' } as const, '')
const database = atom({ plugin: 'sql-console', key: 'database' } as const, '')
const servers = atom({ plugin: 'sql-console', key: 'servers' } as const, [])
const showHelp = atom({ plugin: 'sql-console', key: 'showHelp' } as const, false)
const paste = atom({ plugin: 'sql-console', key: 'paste' } as const, null)
const schema = atom({ plugin: 'sql-console', key: 'schema' } as const, {})
const schemaLoading = atom({ plugin: 'sql-console', key: 'schemaLoading' } as const, '')
const paths = atom({ plugin: 'sql-console', key: 'paths' } as const, null)
const editorScroll = atom({ plugin: 'sql-console', key: 'editorScroll' } as const, null)
const EMPTY_VIEW: SqlView = { expanded: [], top: 0, cursor: 0, left: 0, search: '', match: 0 }
const view = atom({ plugin: 'sql-console', key: 'view' } as const, EMPTY_VIEW)
const menuOpen = atom({ plugin: 'sql-console', key: 'menuOpen' } as const, '')
const editorCmd = atom({ plugin: 'sql-console', key: 'editorCmd' } as const, null)
const confirm = atom({ plugin: 'sql-console', key: 'confirm' } as const, null)

const HELP = `**Top bar**
- **▾ Server** / **▾ Database** — open the list and pick one (from \`servers.json\`; ● is active; production is red) · **↶ ↷** undo / redo
- **Format** — uppercase SQL keywords · **↻ Schema** — reload table and column names · **Help** — this screen

**Editor** (click it to type)
- \`ctrl+r\` / \`ctrl+enter\` or click **▶** in the gutter — run that statement (statements end with \`;\` or a blank line)
- Autocomplete: tables after FROM/JOIN, columns in SELECT/WHERE/ON/BY, \`db.\` → its tables, \`alias.\` → that table's columns, keywords elsewhere · ↑↓ pick, Tab/Enter accept
- Select: shift+arrows, mouse drag, shift+click · \`ctrl+a\` select all · \`ctrl+c\` / \`ctrl+x\` / \`ctrl+v\`
- \`alt+z\` undo · \`alt+y\` / \`alt+shift+z\` redo, or the ↶ ↷ buttons (\`ctrl+z\` suspends Claude Code)
- \`ctrl+l\` format · Home/End · \`ctrl+k\` delete to line end · Tab = 2 spaces

**Result** (click it first)
- Mouse wheel scrolls the editor or the result (whichever is under the pointer)
- \`↑↓\` / \`j k\` move · PgUp/PgDn · \`g\`/\`G\` · \`←\`/\`→\` (or \`h\`/\`l\`) scroll columns, shift for faster
- Enter / Space / click — open a row as column: value lines · \`e\` open all · \`c\` close all
- \`y\` copy as TSV · \`J\` copy as JSON · \`/\` or \`ctrl+f\` find · \`n\`/\`N\` next/previous

**Read-only** — only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, TABLE and VALUES run, one statement at a time, inside a read-only session and transaction. Anything that could write, lock or change the session is refused, whatever the database user may do.

**Files** — one JSON session file per console (default \`~/.claude/mods/sql/sessions/default.json\`: server, database, cursorRow, query, lastRun) + \`<name>.result.json\`; servers in \`~/.claude/mods/sql/servers.json\`. Edits show here live.

**Own console per session/agent** — \`/sql --filepath <name>.json [--configfilepath <servers>.json]\`.

Esc returns the keyboard to the prompt · \`/sql\` toggles this pane.`

const GUIDE = `SQL console (a read-only MySQL query console in a pane the user sees). Each console is one JSON session file, so sessions and agents never overwrite each other: open your own with this tool (filepath) or the user types /sql --filepath <name>.json [--configfilepath <servers>.json]. The current session's files are kept across reloads.

Session file (default ~/.claude/mods/sql/sessions/default.json): {"server": "<name from config>", "database": "<one of that server's databases>", "cursorRow": <0-based line where the statement the user's Run sends starts>, "query": "<editor text>", "lastRun": {server, database, ms, rows, error?, at}}.
- query holds one or more SQL statements; a statement ends with ";" or a blank line.
- To give the user a query, write the session file (keep the other keys); the pane updates within a second. Set "server" (a server id) and "database" for where it should run (staging vs production is the user's call unless they told you), and cursorRow to the statement's first line. Read the file to see the user's edits.
Result file: the session file with .result.json in place of .json: {server, database, sql, columns, rows (array of arrays of strings, "NULL" for null), rowCount, limited, ms, error?, at}. Read it after the user runs.
Config file (default ~/.claude/mods/sql/servers.json): {"servers": [{"id","name","host","port","https","username","password" | "passwordEnv" | "passwordCommand","tag","databases":[...],"maxRows"?,"timeoutSec"?}]}. The session file's "server" is a server id. Never print passwords.
Read-only: only one SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / TABLE / VALUES statement runs at a time, in a read-only session and transaction; anything that writes, locks or changes the session is refused. Don't offer writes or migrations through it.
The user runs statements (▶ in the editor gutter or ctrl+r); do not run them yourself unless asked.`

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
let saveTimer: Timer | undefined
let viewerHeight = 20
let viewerWidth = 80
let editorBottom = 14
let model: { id: number; expandedKey: string; lines: Line[] } | undefined
let matchCache: { key: string; paths: string[] } | undefined

const resultFile = () => sessionFile.replace(/(\.json)?$/, '.result.json')
const schemaFile = () => `${base}/schema.json`
const serverKey = (s: { id: string; host: string }) => `${s.id}@${s.host}`

async function resolvePath($: EngineInterface, p: string, under: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p.startsWith('/')) return p
  return `${under}/${p}`
}

async function write($: EngineInterface, file: string, text: string) {
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
    await update($, servers, () => list.map(s => ({ id: s.id, name: s.name, host: s.host, ...(s.tag ? { tag: s.tag } : {}), databases: s.databases ?? [] })))
    const cur = await read($, server)
    if (list.length && !list.some(s => s.id === cur)) {
      const byName = list.find(s => s.name === cur)
      await update($, server, () => (byName ?? list[0]!).id)
    }
    await pickDatabase($)
  }
  if (await changed($, sessionFile)) {
    const st = await readJson($, sessionFile)
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
        rows: Array.isArray(data.rows) ? data.rows.map((r: unknown[]) => r.map(String)) : [],
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
  const home = (await $.env.get('HOME')) ?? ''
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
    sessionFile = nextFile
    configFile = nextConfig
    for (const k of Object.keys(seen)) delete seen[k]
    await update($, paths, () => ({ file: nextFile, config: nextConfig }))
    await update($, result, () => null)
    await update($, view, () => EMPTY_VIEW)
  }
  await sync($)
  return undefined
}

async function saveSession($: EngineInterface, extra: Record<string, unknown> = {}) {
  if (!sessionFile) return
  const old = (await readJson($, sessionFile)) ?? {}
  const next = {
    ...old,
    server: await read($, server),
    database: await read($, database),
    cursorRow: await read($, cursorRow),
    query: await read($, query),
    ...extra,
  }
  await write($, sessionFile, JSON.stringify(next, null, 2) + '\n')
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
async function runSql($: EngineInterface, creds: DbServer, db: string, sql: string): Promise<{ columns: string[]; rows: string[][]; ms: number; error?: string; limited?: boolean }> {
  const refused = readGuard(sql)
  if (refused) return { columns: [], rows: [], ms: 0, error: refused }
  if (!creds.host) return { columns: [], rows: [], ms: 0, error: `Server "${creds.name}" has no host. Fill it in ${configFile}.` }
  const started = Date.now()
  const { argv, env } = mysqlInvocation(creds, db || undefined, await mysqlBinary($, creds))
  try {
    const out = await $.process.run(argv, { stdin: mysqlScript(sql, creds), env, timeoutMs: ((creds.timeoutSec ?? 60) + 15) * 1000 })
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

async function run($: EngineInterface) {
  if (await read($, running)) return
  const text = await read($, query)
  const stmt = statementAt(text, await read($, cursorRow))
  if (!stmt) return $.ui.toast('No statement in the console.')
  const name = await read($, server)
  const db = await read($, database)
  const target = (await readServers($)).find(s => s.id === name)
  if (!target) return $.ui.toast(`No server "${name}" in ${configFile}`)
  if (!(await isTrusted($, target))) {
    await update($, confirm, () => ({ serverId: target.id, serverName: target.name, target: `${target.host}:${target.port ?? 3306}${target.https ? ' (TLS)' : ''}`, source: credentialSource(target)!, fingerprint: credentialFingerprint(target), then: 'run' as const, sql: stmt.sql, database: db }))
    return
  }
  await runStatement($, target, db, stmt.sql)
}

// Runs one statement on a trusted server and records the result. The guard runs again in runSql.
async function runStatement($: EngineInterface, target: DbServer, db: string, sql: string) {
  const name = target.id
  const stmt = { sql }
  await update($, running, () => true)
  const out = await withPassword($, target)
    .then(creds => runSql($, creds, db, stmt.sql))
    .catch(err => ({ columns: [] as string[], rows: [] as string[][], ms: 0, error: String(err) }))
  const next: SqlResult = { id: Date.now(), server: target.name, database: db, sql: stmt.sql, ...out, at: new Date().toISOString() }
  await update($, result, () => next)
  await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
  await update($, running, () => false)
  const { id: _i, ...file } = next
  await write($, resultFile(), JSON.stringify({ ...file, rowCount: next.rows.length }, null, 2) + '\n')
  await saveSession($, { lastRun: { server: name, database: db, ms: next.ms, rows: next.rows.length, ...(next.error ? { error: next.error.slice(0, 500) } : {}), at: next.at } })
  if (next.error) $.ui.toast(next.error.startsWith('Read-only') ? 'Blocked: read-only console' : `SQL: ${next.error.slice(0, 160)}`)
}

// Reads table and column names for the server's databases into schema.json (SELECT only).
async function refreshSchema($: EngineInterface, name: string) {
  if ((await read($, schemaLoading)) === name) return
  const target = (await readServers($)).find(s => s.id === name)
  if (!target || !target.host) return
  if (!(await isTrusted($, target))) {
    await update($, confirm, () => ({ serverId: target.id, serverName: target.name, target: `${target.host}:${target.port ?? 3306}${target.https ? ' (TLS)' : ''}`, source: credentialSource(target)!, fingerprint: credentialFingerprint(target), then: 'schema' as const, sql: '', database: '' }))
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
    const copied = await $.ui.copy({ text })
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
      description: 'Toggle the read-only SQL console pane',
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
    await attach($, kept?.file, kept?.config)
    $.clock.every(600, () => void sync($).catch(() => undefined))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__sql-console__console' }, async ($, e) => {
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
      if (data.type === 'copy') {
        const copied = await $.ui.copy({ text: String(data.copy ?? '') })
        $.ui.toast(copied.isCopied ? 'Copied' : 'Copy failed')
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
      } else if (data.type === 'key') {
        await viewerKey($, String(data.key), !!data.ctrl, !!data.meta, !!data.shift)
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Client, Markdown } = $.ui.resolve(e) as any
    // The pane's own rows (the terminal's height is larger: transcript, prompt and footer share it).
    const rows = (e.props as any).scroll?.bodyRows ?? e.viewport?.rows ?? 36
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
    const cols = (e.props as any).bodyColumns ?? 100
    const isProd = target?.tag === 'production'
    const dbList = target ? (target.databases.length ? target.databases : sc?.dbs ?? []) : []

    const fixed = 11
    // An open menu sits under the toolbar; the editor gives up its rows.
    const menuRows = (menu === 'server' ? Math.max(1, list.length) + 2 : menu === 'db' ? Math.max(1, dbList.length) + 2 : 0) + (ask ? 6 : 0)
    const editorHeight = Math.max(3, Math.floor((rows - fixed) * 0.4) - menuRows)
    viewerHeight = Math.max(4, rows - fixed - editorHeight)
    viewerWidth = Math.max(20, cols - 4)
    editorBottom = 2 + editorHeight

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
          <Button key="server-menu" label={`▾ ${target ? target.name : 'Choose server'}`} variant="primary" onPress={() => void update($, menuOpen, m => (m === 'server' ? '' : 'server'))} />
          <Button key="db-menu" label={`▾ ${db || 'Database'}`} onPress={() => void update($, menuOpen, m => (m === 'db' ? '' : 'db'))} />
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
            {target ? `${target.name}/${db || '(no database)'}${target.tag ? ` · ${target.tag}` : ''}${isProd ? ', read-only' : ''}` : '(no server)'}
          </Text>
          {target && !target.host ? <Text color="warning">{` · fill in host and user in ${configFile}`}</Text> : null}
        </Text>
        {ask ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#d7a700" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="warning">{`Connect to ${ask.serverName} with these credentials?`}</Text>
            <Text>{`${ask.target} gets ${ask.source}.`}</Text>
            <Text dimColor>Asked once per server, and again whenever its host or credential source changes in the config.</Text>
            <Box flexDirection="row" gap={2} height={1}>
              <Button
                key="trust-yes"
                label="Allow"
                variant="primary"
                onPress={() =>
                  void (async () => {
                    const a = ask
                    await update($, confirm, () => null)
                    const target = (await readServers($)).find(s => s.id === a.serverId)
                    if (!target || credentialFingerprint(target) !== a.fingerprint) return $.ui.toast(`Not run: server "${a.serverName}" changed. Run it again.`)
                    await trust($, a.fingerprint)
                    if (a.then === 'run') await runStatement($, target, a.database, a.sql)
                    else await refreshSchema($, a.serverId)
                  })().catch(() => undefined)
                }
              />
              <Button key="trust-no" label="Cancel" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        {menu === 'server' ? (
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
                      await saveSession($)
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
        {menu === 'db' ? (
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
                    await saveSession($)
                  })()
                }
              />
            ))}
          </Box>
        ) : null}
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
      </Box>
    )
  })
}
