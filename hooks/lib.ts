// Pure helpers: statement parsing, the read-only guard, the mysql invocation,
// result parsing and the result table the viewer draws.

export type Seg = [string, string]
export type Line = { path: string; segs: Seg[]; fold: boolean; depth: number }
export type Statement = { start: number; end: number; sql: string }

// ---- statements ----

// MySQL starts a `--` comment only when whitespace, a control character or the end follows it:
// `1--1` is arithmetic. Every reader of SQL here must agree with the server on this.
// MySQL's test is single-byte (my_isspace / my_iscntrl), so only ASCII control and space count.
export const isDashComment = (s: string, i: number) => s[i] === '-' && s[i + 1] === '-' && (i + 2 >= s.length || s.charCodeAt(i + 2) <= 0x20 || s.charCodeAt(i + 2) === 0x7f)

// Splits the editor text into statements: a `;` outside strings and comments ends one,
// and so does a blank line. `start` is the statement's first line (where ▶ sits).
export function parseStatements(text: string): Statement[] {
  const lines = text.split('\n')
  const out: Statement[] = []
  let cur: { start: number; parts: string[] } | undefined
  let quote: string | undefined
  let block = false
  const close = (end: number) => {
    if (cur && cur.parts.join('\n').replace(/--(\s.*)?$|#.*$/gm, '').trim()) {
      out.push({ start: cur.start, end, sql: cur.parts.join('\n').trim() })
    }
    cur = undefined
  }
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r]!
    if (!quote && !block && line.trim() === '') {
      close(r - 1)
      continue
    }
    let from = 0
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (block) {
        if (c === '*' && line[i + 1] === '/') { block = false; i++ }
        continue
      }
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = undefined
        continue
      }
      if (c === "'" || c === '"' || c === '`') quote = c
      else if (c === '/' && line[i + 1] === '*') { block = true; i++ }
      else if (c === '#' || isDashComment(line, i)) break
      else if (c === ';') {
        const piece = line.slice(from, i)
        if (!cur && piece.trim()) cur = { start: r, parts: [] }
        if (cur) cur.parts.push(piece)
        close(r)
        from = i + 1
      } else if (!cur && !/\s/.test(c)) cur = { start: r, parts: [] }
    }
    const rest = line.slice(from)
    if (cur) cur.parts.push(rest)
    else if (rest.trim() && !/^\s*(--(\s|$)|#)/.test(rest)) cur = { start: r, parts: [rest] }
  }
  close(lines.length - 1)
  return out
}

export function statementAt(text: string, row: number): Statement | undefined {
  const all = parseStatements(text)
  return all.find(s => s.start <= row && row <= s.end) ?? all.filter(s => s.start <= row).pop() ?? all[0]
}

// ---- read-only guard ----

// The statement with comments removed and every string or quoted identifier replaced by a
// placeholder, so the guard reads only SQL keywords. `undefined` when a string never ends.
export function skeleton(sql: string): string | undefined {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (; j < sql.length; j++) {
        if (sql[j] === '\\') j++
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j++
          else break
        }
      }
      if (j >= sql.length) return undefined
      out += c === '`' ? ' _id_ ' : ' _str_ '
      i = j
    } else if (c === '/' && sql[i + 1] === '*') {
      // `/*! ... */` is code MySQL runs; keep it so the guard refuses it.
      if (sql[i + 2] === '!') return out + ' /*! '
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return undefined
      out += ' '
      i = end + 1
    } else if (c === '#' || isDashComment(sql, i)) {
      const end = sql.indexOf('\n', i)
      out += ' '
      i = end < 0 ? sql.length : end
    } else out += c
  }
  return out
}

const FIRST = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES'])

// Words that change data, schema, privileges, sessions or transactions, or run code.
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'CALL', 'DO', 'HANDLER', 'LOAD', 'COPY', 'SET', 'INTO', 'OUTFILE',
  'DUMPFILE', 'EXECUTE', 'EXEC', 'PREPARE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'START', 'BEGIN', 'SAVEPOINT',
  'RELEASE', 'KILL', 'SHUTDOWN', 'INSTALL', 'UNINSTALL', 'FLUSH', 'RESET', 'PURGE', 'OPTIMIZE', 'REPAIR',
  'CHECKSUM', 'CACHE', 'IMPORT', 'CLONE', 'RESTART', 'DELIMITER', 'SHARE', 'NOWAIT',
  // functions that write, lock, or read the server's files
  'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'LOAD_FILE', 'SYS_EXEC', 'SYS_EVAL', 'NEXTVAL', 'SETVAL',
  'LO_IMPORT', 'LO_EXPORT', 'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND',
  'DBLINK', 'DBLINK_EXEC',
])

// mysql client commands: at the start of a line they run in the client, not the server.
const CLIENT_COMMANDS = new Set([
  'SYSTEM', 'SOURCE', 'TEE', 'NOTEE', 'PAGER', 'NOPAGER', 'CONNECT', 'EDIT', 'EGO', 'EXIT', 'QUIT', 'GO', 'HELP',
  'NOWARNING', 'WARNINGS', 'PRINT', 'PROMPT', 'REHASH', 'RESETCONNECTION', 'STATUS', 'USE', 'CHARSET',
  'QUERY_ATTRIBUTES', 'SSL_SESSION_DATA_PRINT',
])

// Why the statement is refused, or undefined when it only reads.
export function readGuard(sql: string): string | undefined {
  const refuse = (why: string) => `Read-only console: not sent, ${why}.`
  const sk = skeleton(sql)
  if (sk === undefined) return refuse('a string, quoted name or comment is never closed')
  if (sk.includes('/*!')) return refuse('`/*! … */` comments are run by MySQL')
  if (sk.includes('\\')) return refuse('a backslash outside a string is a mysql client command')
  const body = sk.replace(/[\s;]+$/, '')
  if (body.includes(';')) return refuse('it holds more than one statement')
  for (const line of body.split('\n')) {
    const first = /^\s*([A-Za-z_]+)/.exec(line)?.[1]?.toUpperCase()
    if (first && CLIENT_COMMANDS.has(first)) return refuse(`\`${first.toLowerCase()}\` at the start of a line is a mysql client command`)
  }
  // `CHARACTER SET x` / `CHARSET x` name an encoding; they write nothing.
  const words = (body.replace(/\bCHARACTER\s+SET\b/gi, ' ').match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map(w => w.toUpperCase())
  const lead = body.trimStart()
  const first = lead.startsWith('(') ? 'SELECT' : words[0]
  if (!first || !FIRST.has(first)) {
    return refuse(`only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, TABLE and VALUES run here (this starts with ${first ?? 'nothing'})`)
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === 'ANALYZE' && words[i - 1] !== 'EXPLAIN') return refuse('ANALYZE TABLE writes statistics')
    if (w === 'CREATE' && first === 'SHOW' && i === 1) continue
    if (WRITE_WORDS.has(w)) return refuse(`it uses ${w}, which can write, lock or change the session`)
  }
  return undefined
}

// ---- running ----

export type ServerTag = 'production' | 'staging' | 'development' | 'local'

// One entry of servers.json. `name` is what the dropdown shows; `id` is what session files keep.
export type DbServer = {
  id: string
  name: string
  engine?: 'mysql'
  host: string
  port?: number
  https?: boolean
  insecure?: boolean
  username?: string
  password?: string
  passwordEnv?: string
  passwordCommand?: string[]
  tag?: ServerTag
  databases?: string[]
  mysqlPath?: string
  maxRows?: number
  timeoutSec?: number
}

const TAGS = new Set(['production', 'staging', 'development', 'local'])

// Reads one config entry into the current shape. `id` falls back to `name`, and the old
// `ssl` flag reads as `https` (TLS required).
export function normalizeServer(raw: unknown): DbServer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const id = str(r.id) ?? str(r.name)
  const host = str(r.host)
  if (!id || host === undefined) return id && typeof r.host === 'string' ? { id, name: str(r.name) ?? id, host: '', port: 3306, https: false } : undefined
  const s: DbServer = { id, name: str(r.name) ?? id, host, port: typeof r.port === 'number' ? r.port : 3306, https: r.https === true || r.ssl === true }
  if (r.insecure === true) s.insecure = true
  if (str(r.username)) s.username = str(r.username)
  if (typeof r.password === 'string') s.password = r.password
  if (str(r.passwordEnv)) s.passwordEnv = str(r.passwordEnv)
  if (Array.isArray(r.passwordCommand) && r.passwordCommand.length && r.passwordCommand.every(a => typeof a === 'string')) s.passwordCommand = r.passwordCommand as string[]
  if (typeof r.tag === 'string' && TAGS.has(r.tag)) s.tag = r.tag as ServerTag
  if (Array.isArray(r.databases)) s.databases = r.databases.map(String).filter(Boolean)
  if (str(r.mysqlPath)) s.mysqlPath = str(r.mysqlPath)
  if (typeof r.maxRows === 'number') s.maxRows = r.maxRows
  if (typeof r.timeoutSec === 'number') s.timeoutSec = r.timeoutSec
  return s
}

export const tagColor = (tag?: ServerTag) => (tag === 'production' ? 'error' : tag === 'staging' ? 'warning' : tag === 'development' ? 'success' : undefined)

// Clipboard readers, tried in turn: macOS, Wayland, X11, Windows.
export const PASTE_COMMANDS = [['pbpaste'], ['wl-paste', '-n'], ['xclip', '-o', '-selection', 'clipboard'], ['powershell.exe', '-NoProfile', '-Command', 'Get-Clipboard']]

export const MYSQL_CANDIDATES = ['/opt/homebrew/opt/mysql-client/bin/mysql', '/opt/homebrew/bin/mysql', '/usr/local/opt/mysql-client/bin/mysql', '/usr/local/bin/mysql', '/usr/bin/mysql']

// The script mysql reads on stdin: the session and the transaction are read-only on the
// server too, so even a statement the guard missed cannot write, whatever the user may do.
export function mysqlScript(sql: string, server: DbServer): string {
  const maxRows = Math.max(1, Math.min(100_000, server.maxRows ?? 1000))
  const ms = Math.max(1, server.timeoutSec ?? 60) * 1000
  return [
    // The guard reads strings with backslash escapes and double quotes as strings; pin the
    // server to the same reading, whatever the user's or server's sql_mode says.
    "SET SESSION sql_mode = REPLACE(REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''), 'ANSI_QUOTES', '');",
    'SET SESSION TRANSACTION READ ONLY;',
    `SET SESSION sql_select_limit = ${maxRows};`,
    `SET SESSION max_execution_time = ${ms};`,
    'START TRANSACTION READ ONLY;',
    sql.replace(/[\s;]+$/, '') + ';',
    'ROLLBACK;',
    '',
  ].join('\n')
}

const cnfQuote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'

// argv and env for one run. The password reaches mysql through an option file read from a
// process substitution, so it never sits on argv or on disk.
export function mysqlInvocation(server: DbServer, database: string | undefined, mysql: string): { argv: string[]; env: Record<string, string> } {
  const args = [
    '--batch',
    '--column-names',
    '--skip-system-command',
    '--connect-timeout=10',
    '--default-character-set=utf8mb4',
    `--host=${server.host}`,
    `--port=${server.port ?? 3306}`,
  ]
  if (server.username) args.push(`--user=${server.username}`)
  if (database) args.push(`--database=${database}`)
  if (server.https) args.push('--ssl-mode=REQUIRED')
  // --defaults-file (first): mysql reads only this option file, never ~/.my.cnf or /etc/my.cnf,
  // where a pager, tee file or init-command could be planted.
  const script = 'exec "$SQLC_MYSQL" --defaults-file=<(printf \'[client]\\npassword=%s\\n\' "$SQLC_PW") "$@"'
  return {
    argv: ['/bin/bash', '-c', script, 'sqlc', ...args],
    env: { SQLC_MYSQL: mysql, SQLC_PW: cnfQuote(server.password ?? '') },
  }
}

// mysql --batch prints a tab-separated header and rows, escaping tab, newline and backslash.
export function parseBatch(stdout: string): { columns: string[]; rows: string[][] } {
  const lines = stdout.replace(/\n$/, '').split('\n')
  if (!lines[0]) return { columns: [], rows: [] }
  const unesc = (v: string) => v.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '␀' : c))
  const columns = lines[0].split('\t').map(unesc)
  const rows = lines.slice(1).map(l => l.split('\t').map(unesc))
  return { columns, rows }
}

export const sqlString = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"

export function schemaQuery(databases: string[]): string {
  return `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${databases.map(sqlString).join(', ')}) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
}

// ---- result table ----

const CELL_MAX = 40
const isNum = (v: string) => /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)
const flat = (v: string) => v.replace(/\n/g, '⏎').replace(/\t/g, ' ')

export function widths(columns: string[], rows: string[][]): number[] {
  return columns.map((c, i) => Math.min(CELL_MAX, Math.max(c.length, ...rows.slice(0, 500).map(r => flat(r[i] ?? '').length))))
}

const fit = (v: string, w: number) => (v.length > w ? v.slice(0, w - 1) + '…' : v.padEnd(w))

// One line per row (plus a header), and a key: value line per column under each expanded row.
export function tableLines(columns: string[], rows: string[][], expanded: ReadonlySet<number>): Line[] {
  if (!columns.length) return [{ path: 'empty', depth: 0, fold: false, segs: [['  ', 'f'], ['(no rows)', 'm']] }]
  const w = widths(columns, rows)
  const out: Line[] = []
  const head: Seg[] = [['  ', 'f']]
  columns.forEach((c, i) => {
    if (i) head.push([' │ ', 'p'])
    head.push([fit(c, w[i]!), 'k'])
  })
  out.push({ path: 'h', depth: 0, fold: false, segs: head })
  out.push({ path: 'hr', depth: 0, fold: false, segs: [['  ', 'f'], [w.map(n => '─'.repeat(n)).join('─┼─'), 'p']] })
  rows.forEach((row, r) => {
    const open = expanded.has(r)
    const segs: Seg[] = [[open ? '▾ ' : '▸ ', 'f']]
    columns.forEach((_, i) => {
      if (i) segs.push([' │ ', 'p'])
      const v = row[i] ?? ''
      segs.push([fit(flat(v), w[i]!), v === 'NULL' ? 'b' : isNum(v) ? 'n' : 's'])
    })
    out.push({ path: `r${r}`, depth: 0, fold: true, segs })
    if (open) {
      const kw = Math.min(30, Math.max(...columns.map(c => c.length)))
      columns.forEach((c, i) => {
        const v = row[i] ?? ''
        v.split('\n').forEach((part, k) => {
          out.push({
            path: `r${r}/c${i}/${k}`,
            depth: 1,
            fold: false,
            segs: [['  ', 'f'], ['    ', ''], [k ? ' '.repeat(kw) : fit(c, kw), 'k'], [k ? '   ' : ' : ', 'p'], [part, v === 'NULL' ? 'b' : isNum(v) ? 'n' : 's']],
          })
        })
      })
    }
  })
  return out
}

export const rowOf = (path: string): number | undefined => {
  const m = /^r(\d+)/.exec(path)
  return m ? Number(m[1]) : undefined
}

// The window of a line from column `left`, keeping the gutter.
export function sliceSegs(segs: Seg[], left: number, width: number): Seg[] {
  const [gutter, ...rest] = segs
  const out: Seg[] = gutter ? [gutter] : []
  let pos = 0
  for (const [t, c] of rest) {
    const a = Math.max(left, pos)
    const b = Math.min(left + width, pos + t.length)
    if (b > a) out.push([t.slice(a - pos, b - pos), c])
    pos += t.length
  }
  return out
}

export const lineText = (l: Line) => l.segs.slice(1).map(s => s[0]).join('')

export function findMatches(all: Line[], term: string): string[] {
  if (!term) return []
  const t = term.toLowerCase()
  return all.filter(l => l.path !== 'hr' && lineText(l).toLowerCase().includes(t)).map(l => l.path)
}

// Splits segments so every occurrence of term carries the highlight code.
export function highlight(segs: Seg[], term: string, code: string): Seg[] {
  if (!term) return segs
  const t = term.toLowerCase()
  const [gutter, ...rest] = segs
  const full = rest.map(s => s[0]).join('')
  const lower = full.toLowerCase()
  const marks: boolean[] = new Array(full.length).fill(false)
  for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) for (let j = i; j < i + t.length; j++) marks[j] = true
  if (!marks.includes(true)) return segs
  const out: Seg[] = gutter ? [gutter] : []
  let pos = 0
  for (const [s, c] of rest) {
    let buf = ''
    let bufHi = false
    for (let i = 0; i < s.length; i++, pos++) {
      const hi = marks[pos]!
      if (buf && hi !== bufHi) {
        out.push([buf, bufHi ? code : c])
        buf = ''
      }
      buf += s[i]
      bufHi = hi
    }
    if (buf) out.push([buf, bufHi ? code : c])
  }
  return out
}

export function toTsv(columns: string[], rows: string[][]): string {
  const cell = (v: string) => v.replace(/\t/g, ' ').replace(/\n/g, '\\n')
  return [columns, ...rows].map(r => r.map(cell).join('\t')).join('\n')
}

// Uppercases SQL keywords outside strings, comments and quoted names.
export function formatSql(text: string, keywords: readonly string[]): string {
  const kw = new Set(keywords)
  return text.replace(/('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|`[^`]*`|--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|\b([A-Za-z_]+)\b/g, (m, skip: string | undefined, word: string | undefined) =>
    skip ? skip : word && kw.has(word.toUpperCase()) ? word.toUpperCase() : m,
  )
}

// `--filepath x.json --configfilepath y.json` (also `--file`, `--config`, `=` forms, quotes).
export function parseArgs(args: string): { file?: string; config?: string; rest: string[] } {
  const tokens = [...args.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map(m => m[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
  const out: { file?: string; config?: string; rest: string[] } = { rest: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const m = /^--?(filepath|file|configfilepath|config)(?:=(.*))?$/.exec(t)
    if (!m) {
      out.rest.push(t)
      continue
    }
    const value = m[2] ?? tokens[++i] ?? ''
    if (m[1] === 'filepath' || m[1] === 'file') out.file = value
    else out.config = value
  }
  return out
}

// Servers that send credentials need the person's OK before the first query: the address and
// where the password comes from, so a changed config (an agent can write it) never sends a secret
// somewhere new, or runs a password command, on its own.
export function credentialSource(s: DbServer): string | undefined {
  if (!s.username) return undefined
  const from = s.passwordCommand ? `password from the command \`${s.passwordCommand.join(' ')}\`` : s.passwordEnv ? `password from $${s.passwordEnv}` : s.password ? 'password from servers.json' : 'no password'
  return `user ${s.username}, ${from}`
}

export function credentialFingerprint(s: DbServer): string {
  return JSON.stringify([s.host, s.port ?? 3306, s.https ?? false, s.username ?? '', s.passwordCommand ?? null, s.passwordEnv ?? null, s.password ? 'file' : null, s.mysqlPath ?? null])
}
