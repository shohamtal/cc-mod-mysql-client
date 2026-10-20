import { describe, expect, test } from 'claude-code/testing'

import { classifyStatement, mysqlWriteScript, normalizeServer, mysqlInvocation, mysqlScript, parseArgs, parseBatch, parseStatements, readGuard, sliceSegs, statementAt, tableLines, formatSql } from './lib'

describe('read-only guard', () => {
  test('lets reads through', async () => {
    for (const sql of [
      'SELECT * FROM users LIMIT 10', 'select id, name from app.users u where u.id = 3;', 'SHOW TABLES', 'SHOW CREATE TABLE users',
      'DESCRIBE users', 'DESC users', 'EXPLAIN SELECT 1', 'EXPLAIN ANALYZE SELECT * FROM t', '(SELECT 1) UNION (SELECT 2)',
      "SELECT 'drop table x; delete' AS s", 'SELECT `update`, `delete` FROM t', "SELECT * FROM t WHERE note = 'it''s; fine'",
      'WITH x AS (SELECT 1 AS a) SELECT * FROM x', 'SHOW VARIABLES LIKE "max%"', 'SELECT CONVERT(name USING utf8mb4) FROM t',
      'SHOW CHARACTER SET', 'SELECT * FROM t -- trailing comment', 'SELECT update_date FROM t', 'TABLE users',
      'SELECT 1-- comment;DROP TABLE t', 'SELECT 1 --\tcomment', 'SELECT 3--1',
    ]) expect(readGuard(sql)).toBeUndefined()
  })

  test('refuses writes, DDL, locks, sessions and transactions', async () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'DROP TABLE t',
      'TRUNCATE t', 'ALTER TABLE t ADD c INT', 'CREATE TABLE x (a INT)', 'GRANT ALL ON *.* TO x', 'RENAME TABLE a TO b',
      'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR SHARE', 'SELECT * FROM t LOCK IN SHARE MODE', 'LOCK TABLES t READ',
      'SET autocommit = 1', 'COMMIT', 'START TRANSACTION', 'CALL proc()', 'DO SLEEP(1)', 'LOAD DATA INFILE "x" INTO TABLE t',
      'SELECT * INTO OUTFILE "/tmp/x" FROM t', 'SELECT a INTO @v FROM t', 'SELECT GET_LOCK("x", 1)', 'SELECT LOAD_FILE("/etc/passwd")',
      'ANALYZE TABLE t', 'OPTIMIZE TABLE t', 'WITH x AS (SELECT 1) DELETE FROM t', 'PREPARE s FROM "DELETE FROM t"',
      'HANDLER t OPEN', 'KILL 12', 'FLUSH TABLES', 'USE other',
    ]) expect(readGuard(sql)).toBeDefined()
  })

  test('refuses tricks that hide a second statement or a client command', async () => {
    for (const sql of [
      'SELECT 1; DELETE FROM t', 'SELECT 1;\nDROP TABLE t;', 'SELECT 1 /*! ; DELETE FROM t */', 'SELECT /*!50000 SLEEP(1) */ 1',
      'SELECT 1\n\\! rm -rf ~', 'SELECT 1 \\G', 'SELECT 1\nsystem ls', 'SELECT 1\nsource /tmp/evil.sql', "SELECT 'unterminated",
      'SELECT 1 /* never closed', 'SELECT 1\ndelimiter //', 'SELECT 1\nconnect other_host', 'SELECT 1\nuse mysql',
      // `--` without a following space is not a comment to MySQL (security review, finding 1)
      'SELECT 1--1;CREATE TABLE pwned(i INT)', 'SELECT 1--x\n;DROP TABLE t', 'SELECT 2 --1;DELETE FROM t',
      "SELECT 1--'\n;INSERT INTO t VALUES(1)", 'SELECT 1--\u00a0;DROP TABLE t', 'SELECT 1--\u3000;DROP TABLE t',
    ]) expect(readGuard(sql)).toBeDefined()
  })
})

describe('running', () => {
  test('the password never reaches argv', async () => {
    const { argv, env } = mysqlInvocation({ id: 's', name: 's', host: 'db.example', port: 3306, username: 'reader', password: 'p"a\\ss#;w' }, 'app', '/usr/bin/mysql')
    expect(argv.join(' ')).not.toContain('p"a')
    expect(argv).toContain('--skip-system-command')
    expect(argv).toContain('--database=app')
    expect(env.SQLC_PW).toBe('"p\\"a\\\\ss#;w"')
  })

  test('every query runs inside a read-only session and transaction', async () => {
    const script = mysqlScript('SELECT 1;', { id: 's', name: 's', host: 'h', maxRows: 50 })
    expect(script).toBe("SET SESSION sql_mode = REPLACE(REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''), 'ANSI_QUOTES', '');\n" + 'SET SESSION TRANSACTION READ ONLY;\nSET SESSION sql_select_limit = 50;\nSET SESSION max_execution_time = 60000;\nSTART TRANSACTION READ ONLY;\nSELECT 1;\nROLLBACK;\n')
  })

  test('parses mysql batch output', async () => {
    expect(parseBatch('id\tnote\n1\ta\\tb\\nc\n2\tNULL\n')).toEqual({ columns: ['id', 'note'], rows: [['1', 'a\tb\nc'], ['2', 'NULL']] })
  })
})

describe('editor text', () => {
  const TEXT = `-- comment
SHOW TABLES;

SELECT *
FROM users
WHERE note = 'a;b'
LIMIT 10;
SELECT 2; SELECT 3`

  test('splits statements on ; and blank lines, ignoring strings and comments', async () => {
    const all = parseStatements(TEXT)
    expect(all.map(s => s.start)).toEqual([1, 3, 7, 7])
    expect(all[1]!.sql).toBe("SELECT *\nFROM users\nWHERE note = 'a;b'\nLIMIT 10")
    expect(statementAt(TEXT, 5)!.start).toBe(3)
  })

  test('format uppercases keywords but not strings or names', async () => {
    expect(formatSql("select `from`, 'select' from t where a in (1)", ['SELECT', 'FROM', 'WHERE', 'IN'])).toBe("SELECT `from`, 'select' FROM t WHERE a IN (1)")
  })

  test('parses /sql arguments', async () => {
    expect(parseArgs('--filepath a.json --configfilepath ~/c.json')).toEqual({ file: 'a.json', config: '~/c.json', rest: [] })
  })
})

describe('result table', () => {
  test('draws a header, rows, and an expanded row as column: value lines', async () => {
    const lines = tableLines(['id', 'name'], [['1', 'Ann'], ['2', 'NULL']], new Set([1]))
    expect(lines.map(l => l.path)).toEqual(['h', 'hr', 'r0', 'r1', 'r1/c0/0', 'r1/c1/0'])
    expect(lines[3]!.segs.find(s => s[0].trim() === 'NULL')![1]).toBe('b')
  })

  test('scrolls columns horizontally, keeping the gutter', async () => {
    expect(sliceSegs([['▸ ', 'f'], ['abcdef', 's'], [' │ ', 'p'], ['xyz', 'n']], 4, 5)).toEqual([['▸ ', 'f'], ['ef', 's'], [' │ ', 'p']])
  })
})

describe('servers', () => {
  test('id falls back to name; old ssl reads as https; port defaults to 3306', async () => {
    expect(normalizeServer({ name: 'stg', host: 'db.example', ssl: true, databases: ['app'] })).toEqual({
      id: 'stg', name: 'stg', host: 'db.example', port: 3306, https: true, databases: ['app'],
    })
  })
  test('the new shape keeps tags and password sources', async () => {
    const s = normalizeServer({ id: 'prd', name: 'Production', host: 'h', tag: 'production', username: 'r', passwordEnv: 'DB_PW', passwordCommand: ['pass', 'db'] })!
    expect([s.tag, s.passwordEnv, s.passwordCommand]).toEqual(['production', 'DB_PW', ['pass', 'db']])
  })
  test('a host must be a plain name or address', async () => {
    expect(normalizeServer({ id: 'x', host: 'db.example\n[client]' })).toBeUndefined()
    expect(normalizeServer({ id: 'x', host: 'DB.Example.com' })!.host).toBe('db.example.com')
  })
  test('an empty host stays listed so the pane can say what to fill in', async () => {
    expect(normalizeServer({ id: 'new', host: '' })!.host).toBe('')
    expect(normalizeServer({ id: 'x' })).toBeUndefined()
  })
})

describe('writes the person can unlock', () => {
  test('only plain INSERT, UPDATE and DELETE are writes', async () => {
    expect(classifyStatement('INSERT INTO t (a) VALUES (1)')).toMatchObject({ kind: 'write', verb: 'INSERT', noWhere: false })
    expect(classifyStatement("UPDATE t SET a = 'x' WHERE id = 3")).toMatchObject({ kind: 'write', verb: 'UPDATE', noWhere: false })
    expect(classifyStatement('DELETE FROM t WHERE id = 3;')).toMatchObject({ kind: 'write', verb: 'DELETE', noWhere: false })
    expect(classifyStatement('INSERT INTO t SELECT * FROM u WHERE x = 1')).toMatchObject({ kind: 'write', verb: 'INSERT', noWhere: false })
    expect(classifyStatement('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2').kind).toBe('write')
    expect(classifyStatement('SELECT 1').kind).toBe('read')
  })

  test('UPDATE or DELETE without WHERE is flagged', async () => {
    expect(classifyStatement('UPDATE t SET a = 1')).toMatchObject({ kind: 'write', verb: 'UPDATE', noWhere: true })
    expect(classifyStatement("DELETE FROM t -- WHERE id = 1")).toMatchObject({ kind: 'write', verb: 'DELETE', noWhere: true })
    expect(classifyStatement("UPDATE t SET note = 'where' ")).toMatchObject({ kind: 'write', verb: 'UPDATE', noWhere: true })
  })

  test('everything else that changes something stays refused, unlocked or not', async () => {
    for (const sql of [
      'DROP TABLE t', 'TRUNCATE t', 'ALTER TABLE t ADD c INT', 'CREATE TABLE x (a INT)', 'RENAME TABLE a TO b', 'GRANT ALL ON *.* TO x',
      'REPLACE INTO t VALUES (1)', 'LOAD DATA INFILE "x" INTO TABLE t', 'LOAD DATA LOCAL INFILE "/etc/passwd" INTO TABLE t',
      'INSERT INTO t SELECT * FROM u INTO OUTFILE "/tmp/x"', 'DELETE FROM t WHERE id = GET_LOCK("x", 1)', 'CALL p()',
      'UPDATE t SET a = 1; DROP TABLE t', 'DELETE FROM t WHERE id = 1--1;DROP TABLE u', 'INSERT INTO t VALUES (1) /*! ; DROP TABLE t */',
      'UPDATE t SET a = 1\nsystem rm -rf ~', 'SET autocommit = 0', 'START TRANSACTION', 'COMMIT', 'LOCK TABLES t WRITE',
      'UPDATE t SET a = LOAD_FILE("/etc/passwd") WHERE id = 1', 'WITH x AS (SELECT 1) DELETE FROM t',
    ]) expect(classifyStatement(sql).kind).toBe('refused')
  })

  test('an approved write runs in one transaction and reports affected rows, without the read-only session', async () => {
    expect(mysqlWriteScript('UPDATE t SET a = 1 WHERE id = 2;')).toBe(
      "SET SESSION sql_mode = REPLACE(REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''), 'ANSI_QUOTES', '');\nSTART TRANSACTION;\nUPDATE t SET a = 1 WHERE id = 2;\nSELECT ROW_COUNT() AS affected_rows;\nCOMMIT;\n",
    )
  })
})

describe('security review of the write toggle', () => {
  test('system schemas are never written, named, quoted or selected', async () => {
    for (const sql of ["UPDATE mysql.user SET authentication_string = '' WHERE user = 'x'", 'UPDATE `mysql`.`user` SET a = 1 WHERE b = 2',
      'UPDATE performance_schema.setup_instruments SET ENABLED = "NO" WHERE NAME LIKE "%"', 'DELETE FROM sys . x WHERE a = 1',
      'INSERT INTO t SELECT * FROM information_schema.tables WHERE 0']) expect(classifyStatement(sql).kind).toBe('refused')
    expect(classifyStatement('DELETE FROM user WHERE id = 1', 'mysql').kind).toBe('refused')
    expect(classifyStatement('DELETE FROM user WHERE id = 1', 'app').kind).toBe('write')
  })
  test('the no-WHERE warning ignores a WHERE inside parentheses, and WHERE 1 / TRUE / 1=1', async () => {
    expect(classifyStatement('UPDATE t SET a = (SELECT 1 FROM u WHERE u.id = 2)')).toMatchObject({ noWhere: true })
    for (const w of ['1', 'TRUE', '1=1', '1 = 1', "'1'='1'"]) expect(classifyStatement(`DELETE FROM t WHERE ${w}`)).toMatchObject({ noWhere: true })
    expect(classifyStatement('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)')).toMatchObject({ noWhere: false })
  })
  test('optimizer hints are refused in writes', async () => {
    expect(classifyStatement('UPDATE /*+ SET_VAR(foreign_key_checks=OFF) */ t SET a = 1 WHERE b = 1').kind).toBe('refused')
  })
  test('calls to functions that may be stored functions are named for the prompt', async () => {
    expect(classifyStatement("UPDATE t SET a = NOW(), b = CONCAT(a, 'x'), c = audit_log(a) WHERE id = 1")).toMatchObject({ calls: ['audit_log'] })
    expect(classifyStatement('DELETE FROM t WHERE id = app.next_id()')).toMatchObject({ calls: ['app.next_id'] })
  })
})
