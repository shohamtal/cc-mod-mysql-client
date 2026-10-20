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

// The statement as MySQL tokenizes it, minus comments: strings become '_str_', quoted names stay
// (with their backticks), and every comment becomes one space. `undefined` when something never ends.
export function decomment(sql: string): string | undefined {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (; j < sql.length; j++) {
        if (sql[j] === '\\' && c !== '`') j++
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j++
          else break
        }
      }
      if (j >= sql.length) return undefined
      out += c === '`' ? sql.slice(i, j + 1) : " '_str_' "
      i = j
    } else if (c === '/' && sql[i + 1] === '*') {
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

// What the guard reads: the statement's words (uppercased, strings and comments removed),
// or why its shape alone is refused. Every statement passes this, read or write.
function structure(sql: string): { words: string[]; body: string } | { refused: string } {
  const refuse = (why: string) => ({ refused: `Not sent: ${why}.` })
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
  return { words, body }
}

// Why the statement is refused, or undefined when it only reads.
export function readGuard(sql: string): string | undefined {
  const refuse = (why: string) => `Read-only console: not sent, ${why}.`
  const st = structure(sql)
  if ('refused' in st) return `Read-only console: ${st.refused.charAt(0).toLowerCase()}${st.refused.slice(1)}`
  const { words, body } = st
  if (/\/\*\+[\s\S]*?\b(SET_VAR|MAX_EXECUTION_TIME)\b/i.test(sql)) return refuse('optimizer hints that change session settings or the time limit are not allowed')
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

// The writes the console can run once the person approves them: one data change (INSERT, UPDATE,
// DELETE, REPLACE), schema change (CREATE, ALTER, DROP, TRUNCATE, RENAME), privilege change
// (GRANT, REVOKE) or procedure call (CALL). Still refused, approved or not: anything that touches
// files (LOAD, OUTFILE, DUMPFILE, LOAD_FILE), controls the session or server (SET, transactions,
// locks, KILL, SHUTDOWN, plugins), or hides more than the one statement the prompt shows.
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'CALL'])
// Statements MySQL commits at once: they can't be rolled back. A CALL may commit inside, too.
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE'])
// Words that stay refused inside any write.
const NEVER_IN_WRITE = new Set([
  'LOAD', 'OUTFILE', 'DUMPFILE', 'LOAD_FILE', 'SYS_EXEC', 'SYS_EVAL', 'HANDLER', 'KILL', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'UNLOCK', 'PREPARE', 'DEALLOCATE', 'DELIMITER', 'INSTALL', 'UNINSTALL', 'CLONE', 'RESTART',
  'IMPORT', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'DBLINK', 'DBLINK_EXEC', 'SONAME',
])
// The objects CREATE / ALTER / DROP / RENAME may name. Routines, triggers and events run later
// without a prompt, so they can be dropped here but not created or changed; server objects
// (INSTANCE, TABLESPACE, SERVER, RESOURCE GROUP, …) are never touched.
const OBJECTS: Record<string, Set<string>> = {
  CREATE: new Set(['TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'USER', 'ROLE']),
  ALTER: new Set(['TABLE', 'VIEW', 'DATABASE', 'SCHEMA', 'USER']),
  DROP: new Set(['TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'USER', 'ROLE', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']),
  RENAME: new Set(['TABLE', 'USER']),
}
// Words between the verb and the object type: CREATE OR REPLACE ALGORITHM = MERGE SQL SECURITY INVOKER VIEW …
const OBJECT_MODIFIERS = new Set(['OR', 'REPLACE', 'TEMPORARY', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'ONLINE', 'OFFLINE', 'ALGORITHM', 'UNDEFINED', 'MERGE', 'TEMPTABLE', 'SQL', 'SECURITY', 'INVOKER', 'DEFINER'])
// Privilege names a GRANT / REVOKE may list that are refused elsewhere.
const PRIVILEGE_WORDS = new Set(['SHUTDOWN', 'RELOAD', 'PROCESS', 'FILE', 'EXECUTE', 'LOCK', 'REPLICATION', 'SUPER', 'EVENT', 'TRIGGER', 'CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'INDEX', 'REFERENCES', 'USAGE'])

export type Classified =
  | { kind: 'read' }
  | { kind: 'write'; verb: string; noWhere: boolean; calls: string[]; ddl: boolean }
  | { kind: 'refused'; reason: string }

// Schemas whose tables are the server's own (accounts, privileges, instrumentation).
export const SYSTEM_SCHEMAS = ['mysql', 'sys', 'performance_schema', 'information_schema']
const SYSTEM_REF = new RegExp(`(^|[^A-Za-z0-9_$])\`?(${SYSTEM_SCHEMAS.join('|')})\`?\\s*\\.`, 'i')

// Built-in functions an INSERT / UPDATE / DELETE may call without a warning. Anything else may be
// a stored function, which can write more on its own, so the prompt names it.
const BUILTINS = new Set(('ABS ACOS ADDDATE ADDTIME AES_DECRYPT AES_ENCRYPT ANY_VALUE ASCII ASIN ATAN ATAN2 AVG BIN BIT_AND BIT_COUNT BIT_LENGTH BIT_OR BIT_XOR CAST CEIL CEILING CHAR CHAR_LENGTH CHARACTER_LENGTH COALESCE CONCAT CONCAT_WS CONV CONVERT CONVERT_TZ COS COT COUNT CRC32 CURDATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURTIME DATE DATE_ADD DATE_FORMAT DATE_SUB DATEDIFF DAY DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR DEGREES ELT EXP EXTRACT FIELD FIND_IN_SET FLOOR FORMAT FROM_BASE64 FROM_DAYS FROM_UNIXTIME GREATEST GROUP_CONCAT HEX HOUR IF IFNULL IN INET_ATON INET_NTOA INSERT INSTR INTERVAL ISNULL JSON_ARRAY JSON_ARRAY_APPEND JSON_ARRAY_INSERT JSON_CONTAINS JSON_CONTAINS_PATH JSON_EXTRACT JSON_INSERT JSON_KEYS JSON_LENGTH JSON_MERGE_PATCH JSON_MERGE_PRESERVE JSON_OBJECT JSON_QUOTE JSON_REMOVE JSON_REPLACE JSON_SEARCH JSON_SET JSON_TYPE JSON_UNQUOTE JSON_VALID LAST_DAY LAST_INSERT_ID LCASE LEAST LEFT LENGTH LN LOCALTIME LOCALTIMESTAMP LOCATE LOG LOG10 LOG2 LOWER LPAD LTRIM MAKEDATE MAKETIME MAX MD5 MICROSECOND MID MIN MINUTE MOD MONTH MONTHNAME NOW NULLIF OCT ORD PERIOD_ADD PERIOD_DIFF PI POSITION POW POWER QUARTER QUOTE RADIANS RAND REGEXP_INSTR REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR REPEAT REPLACE REVERSE RIGHT ROUND RPAD RTRIM SEC_TO_TIME SECOND SHA1 SHA2 SIGN SIN SPACE SQRT STD STDDEV STR_TO_DATE STRCMP SUBDATE SUBSTR SUBSTRING SUBSTRING_INDEX SUBTIME SUM SYSDATE TAN TIME TIME_FORMAT TIME_TO_SEC TIMEDIFF TIMESTAMP TIMESTAMPADD TIMESTAMPDIFF TO_BASE64 TO_DAYS TO_SECONDS TRIM TRUNCATE UCASE UNHEX UNIX_TIMESTAMP UPPER USER UTC_DATE UTC_TIME UTC_TIMESTAMP UUID UUID_SHORT UUID_TO_BIN BIN_TO_UUID VALUES VAR_POP VAR_SAMP VARIANCE WEEK WEEKDAY WEEKOFYEAR YEAR YEARWEEK ' +
  'EXISTS NOT AND OR SELECT FROM WHERE AS ON USING JOIN LIMIT ORDER BY GROUP HAVING DISTINCT ALL ANY SOME CASE WHEN THEN ELSE END INTO SET UPDATE DELETE KEY DUPLICATE NULL TRUE FALSE BETWEEN LIKE IS REGEXP RLIKE DIV').split(' '))

// Where the statement's own WHERE starts (outside any parentheses), or -1.
function topLevelWhere(sk: string): number {
  let depth = 0
  for (let i = 0; i < sk.length; i++) {
    const c = sk[i]!
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /^WHERE\b/i.test(sk.slice(i, i + 6)) && !/[A-Za-z0-9_$]/.test(sk[i - 1] ?? ' ')) return i
  }
  return -1
}

// The condition without a trailing ORDER BY / LIMIT at its own level.
function cutTail(cond: string): string {
  let depth = 0
  for (let i = 0; i < cond.length; i++) {
    const c = cond[i]!
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /^(ORDER|LIMIT)\b/i.test(cond.slice(i, i + 6)) && !/[A-Za-z0-9_$]/.test(cond[i - 1] ?? ' ')) return cond.slice(0, i)
  }
  return cond
}

// Strips parentheses that wrap the whole condition: `((1))` reads as `1`.
function unwrap(cond: string): string {
  let c = cond.trim()
  for (;;) {
    if (!c.startsWith('(') || !c.endsWith(')')) return c
    let depth = 0
    let wraps = true
    for (let i = 0; i < c.length; i++) {
      if (c[i] === '(') depth++
      else if (c[i] === ')') depth--
      if (depth === 0 && i < c.length - 1) {
        wraps = false
        break
      }
    }
    if (!wraps) return c
    c = c.slice(1, -1).trim()
  }
}

// WHERE conditions that keep every row: TRUE, a non-zero number, NOT 0 / FALSE, n = n, 1 > 0 …
function alwaysTrue(cond: string): boolean {
  const c = cond.trim()
  if (!c) return false
  if (/^(TRUE|[1-9]\d*(\.\d+)?|NOT\s+(0|FALSE|NULL))$/i.test(c)) return true
  const cmp = /^(\S+)\s*(=|>=|<=|<=>)\s*(\S+)$/.exec(c)
  if (cmp && cmp[1] === cmp[3]) return true
  const num = /^(-?\d+(?:\.\d+)?)\s*(>|<|>=|<=|<>|!=)\s*(-?\d+(?:\.\d+)?)$/.exec(c)
  if (num) {
    const a = Number(num[1]), b = Number(num[3])
    return ({ '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b, '<>': a !== b, '!=': a !== b } as Record<string, boolean>)[num[2]!] ?? false
  }
  return false
}


export function classifyStatement(sql: string, database?: string): Classified {
  if (!readGuard(sql)) return { kind: 'read' }
  const st = structure(sql)
  if ('refused' in st) return { kind: 'refused', reason: st.refused }
  const { words, body } = st
  const verb = words[0]
  if (!verb || !WRITE_VERBS.has(verb)) return { kind: 'refused', reason: readGuard(sql)! }
  const isGrant = verb === 'GRANT' || verb === 'REVOKE'
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (NEVER_IN_WRITE.has(w) && !(isGrant && PRIVILEGE_WORDS.has(w))) return { kind: 'refused', reason: `Not sent: it uses ${w}, which the console never runs (files, session or server control).` }
    if (w === 'SHUTDOWN' && !isGrant) return { kind: 'refused', reason: 'Not sent: SHUTDOWN controls the server.' }
    // `LOCK TABLES` / `START TRANSACTION` / `SET …` as their own statements are never write verbs, but
    // may hide inside procedures' bodies or events.
    if ((w === 'START' && words[i + 1] === 'TRANSACTION') || (w === 'LOCK' && (words[i + 1] === 'TABLES' || words[i + 1] === 'TABLE') && verb !== 'GRANT' && verb !== 'REVOKE')) return { kind: 'refused', reason: `Not sent: ${w} ${words[i + 1]} controls the session.` }
  }
  // An object owned by another account runs later with that account's rights.
  if (/\bDEFINER\s*=/i.test(body)) return { kind: 'refused', reason: 'Not sent: DEFINER = … makes the object run as another account; leave it out.' }
  const objects = OBJECTS[verb]
  if (objects) {
    const object = words.slice(1).find(w => !OBJECT_MODIFIERS.has(w))
    if (!object || !objects.has(object)) {
      const routine = object && ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'AGGREGATE'].includes(object)
      return { kind: 'refused', reason: routine ? `Not sent: ${object === 'EVENT' ? 'an' : 'a'} ${object.toLowerCase()} runs later without a prompt; create or change it with a migration tool.` : `Not sent: the console doesn't ${verb} ${object ?? 'that'} (only ${[...objects].join(', ')}).` }
    }
  }
  // Table options that put data on the server's disk or in another server.
  if ((verb === 'CREATE' || verb === 'ALTER') && words.some(w => w === 'DIRECTORY' || w === 'CONNECTION')) {
    return { kind: 'refused', reason: 'Not sent: DATA / INDEX DIRECTORY and CONNECTION place a table on the server\'s disk or another server.' }
  }
  // The server's own tables (accounts, privileges) are never written, whether named or selected.
  if (database && SYSTEM_SCHEMAS.includes(database.toLowerCase())) return { kind: 'refused', reason: `Not sent: ${database} is a system schema; the console never writes to it.` }
  const plain = decomment(sql) ?? sql
  if (/^\s*(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?(mysql|sys|performance_schema|information_schema)`?\s*$/i.test(plain.replace(/[\s;]+$/, ''))) {
    return { kind: 'refused', reason: 'Not sent: the console never changes a system schema.' }
  }
  if (SYSTEM_REF.test(plain)) return { kind: 'refused', reason: `Not sent: it names a system schema (${SYSTEM_SCHEMAS.join(', ')}); the console never writes to them.` }
  // Optimizer hints like /*+ SET_VAR(foreign_key_checks=OFF) */ change how the write runs.
  if (/\/\*\+/.test(sql)) return { kind: 'refused', reason: 'Not sent: optimizer hints (/*+ … */) can change session settings for the write; remove them.' }
  // The warning counts only a WHERE at the statement's own level, and one that filters nothing.
  const at = topLevelWhere(body)
  const cond = at < 0 ? '' : unwrap(cutTail(body.slice(at + 5)))
  const filtersNothing = at >= 0 && alwaysTrue(cond)
  const noWhere = (verb === 'UPDATE' || verb === 'DELETE') && (at < 0 || filtersNothing)
  const NAME = '(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)'
  const callRe = new RegExp(`(\\bINTO\\s+)?(${NAME}(?:\\s*\\.\\s*${NAME})?)\\s*\\(`, 'gi')
  const calls = [...new Set([...plain.matchAll(callRe)].filter(x => !x[1]).map(x => x[2]!.replace(/\s+/g, '').replace(/`/g, '')).filter(n => n.includes('.') || !BUILTINS.has(n.toUpperCase())))]
  const realCalls = verb === 'CALL' ? calls.filter((_, i) => i > 0) : calls
  return { kind: 'write', verb, noWhere, calls: realCalls, ddl: DDL_VERBS.has(verb) || verb === 'CALL' }
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
  // A host is a name or an address, never text that could garble a prompt or an option.
  if (!/^[A-Za-z0-9._\-:[\]]+$/.test(host)) return undefined
  const s: DbServer = { id, name: str(r.name) ?? id, host: host.toLowerCase(), port: typeof r.port === 'number' ? r.port : 3306, https: r.https === true || r.ssl === true }
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
export const COPY_COMMANDS = [['pbcopy'], ['wl-copy'], ['xclip', '-i', '-selection', 'clipboard'], ['clip.exe']]
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

// The script for a write the person approved: the same pinned sql_mode, one transaction, and the
// number of rows it changed. If the statement fails, mysql stops before COMMIT and the server
// rolls the transaction back when the connection closes.
export function mysqlWriteScript(sql: string): string {
  return [
    "SET SESSION sql_mode = REPLACE(REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''), 'ANSI_QUOTES', '');",
    'START TRANSACTION;',
    sql.replace(/[\s;]+$/, '') + ';',
    'SELECT ROW_COUNT() AS affected_rows;',
    'COMMIT;',
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
// Anything that sends a secret or runs a program counts, with or without a username.
export function credentialSource(s: DbServer): string | undefined {
  const parts: string[] = []
  if (s.username) parts.push(`user ${JSON.stringify(s.username)}`)
  if (s.passwordCommand) parts.push(`password from the command ${JSON.stringify(s.passwordCommand)}`)
  else if (s.passwordEnv) parts.push(`password from $${JSON.stringify(s.passwordEnv).slice(1, -1)}`)
  else if (s.password) parts.push('password from servers.json')
  if (s.mysqlPath) parts.push(`mysql client at ${JSON.stringify(s.mysqlPath)}`)
  return parts.length ? parts.join(', ') : undefined
}

export function credentialFingerprint(s: DbServer): string {
  return JSON.stringify([s.host, s.port ?? 3306, s.https ?? false, s.username ?? '', s.passwordCommand ?? null, s.passwordEnv ?? null, s.password ? 'file' : null, s.mysqlPath ?? null])
}

// Text as a prompt draws it: printable ASCII and newlines only, anything else as \\uXXXX.
export const asciiView = (t: string) => t.replace(/[^\x20-\x7e\n]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

// The rows a text takes at a width: its lines, each cut into width-long pieces.
export function wrapRows(text: string, width: number): string[] {
  const w = Math.max(10, width)
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line) out.push('')
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w))
  }
  return out
}

// From offset `from` in an ASCII text, the rows that fit `height` rows of `width` columns, and the
// offset just after the last character shown. Reading moves only forward, one shown page at a time.
export function pageFrom(text: string, from: number, width: number, height: number): { rows: string[]; end: number } {
  const w = Math.max(10, width)
  const rows: string[] = []
  let i = Math.max(0, from)
  while (rows.length < height && i < text.length) {
    const nl = text.indexOf('\n', i)
    const lineEnd = nl < 0 ? text.length : nl
    const piece = text.slice(i, Math.min(lineEnd, i + w))
    rows.push(piece)
    i += piece.length
    if (i === lineEnd && nl >= 0) i++
  }
  return { rows, end: i }
}

// The console tool's description. Claude Code passes the model only its first 2048 characters, so
// the rules come first and the whole text stays under that.
export const GUIDE = `MySQL console in a pane the user sees. The user runs statements (▶ or ctrl+r); don't run them yourself unless asked.
Reads (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / TABLE / VALUES) run in a read-only session. A write (INSERT / UPDATE / DELETE / REPLACE, CREATE / ALTER / DROP / TRUNCATE / RENAME, GRANT / REVOKE, CALL) opens a prompt: only the user can run it once or unlock writes for the session (no session unlock on production). Never edit servers.json to unlock. Always refused: several statements, files (LOAD, OUTFILE), SET / transactions / locks / KILL, server objects, SONAME, DEFINER, system schemas, creating routines / triggers / events. Put a WHERE on UPDATE / DELETE unless the user wants every row; say when DDL can't be undone.
Call this tool with action "status" first: it names this session's files. Each console is one session file; open your own with filepath (the user: /sql --filepath <name>.json [--configfilepath <servers>.json]).
Session file (default ~/.claude/mods/sql/sessions/default.json): {"server": <server id>, "database", "cursorRow": <0-based first line of the statement Run sends>, "query": <editor text; statements end with ";" or a blank line>, "lastRun"}. To give the user a query, write it (keep the other keys); the pane updates within a second. Keep the server unless told (staging vs production is the user's call).
Result file: <session>.result.json: {server, database, sql, columns, rows (arrays of strings, "NULL" for null), rowCount, limited, ms, error?, at}. Read it after the user runs.
Config file (default ~/.claude/mods/sql/servers.json): {"servers": [{"id","name","host","port","username","password" | "passwordEnv" | "passwordCommand","tag","databases"}]}; with this tool, configfilepath must be inside ~/.claude/mods/sql/ (not sessions/). Never print passwords.`
