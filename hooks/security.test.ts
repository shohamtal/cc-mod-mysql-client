import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { credentialFingerprint, mysqlInvocation, normalizeServer } from './lib'

const TOOL = 'mcp__sql-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`
const PANE = { plugin: 'sql-console', surface: 'terminal', component: 'Pane', requestId: 'sql', props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any

function world(on: On, servers: unknown[]) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let clock = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
  mock.store(on)
  mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, clock++)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path) && e.path !== BASE && e.path !== `${BASE}/sessions`) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const isMysql = e.argv[0] === '/bin/bash'
    return { value: { exitCode: 0, stdout: isMysql ? 'x\n1\n' : 'secret-from-command\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  const mysql = () => runs.filter(r => r.argv[0] === '/bin/bash')
  return { files, runs, mysql, writes: () => mysql().filter(r => !(r.stdin ?? '').includes('READ ONLY')) }
}

describe('credentials', () => {
  test('a server with credentials asks first; nothing runs, not even its passwordCommand, until Allow', async ($, on) => {
    const w = world(on, [{ id: 'db', name: 'DB', host: 'db.example', username: 'reader', passwordCommand: ['pass', 'db'], databases: ['app'] }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'trust-yes' })).toBeDefined()
    expect(w.runs).toEqual([])
    await ui.press({ key: 'trust-yes' })
    expect(w.runs.map(r => r.argv[0])).toEqual(['pass', '/bin/bash'])
    expect(w.mysql()[0]!.stdin).toContain('\nSELECT 1;\n')
  })

  test('a server without credentials runs at once', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: 'localhost', databases: ['app'] }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's2.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'trust-yes' })).toBeUndefined()
    expect(w.mysql().length).toBe(1)
  })

  test('the agent tool opens a console without running password commands or queries', async ($, on) => {
    const w = world(on, [{ id: 'db', name: 'DB', host: 'h', username: 'u', passwordCommand: ['sh', '-c', 'evil'] }])
    await $.tool.call({ tool: TOOL, action: 'open', filepath: 'agent.json' } as any)
    expect(w.runs).toEqual([])
  })

  for (const [label, entry] of [
    ['passwordCommand', { passwordCommand: ['sh', '-c', 'evil'] }],
    ['passwordEnv', { passwordEnv: 'GITHUB_TOKEN' }],
    ['mysqlPath', { mysqlPath: '/tmp/evil-mysql' }],
  ] as const) {
    test(`an entry without a username but with ${label} still asks first, and the tool runs nothing`, async ($, on) => {
      const w = world(on, [{ id: 'db', name: 'DB', host: 'h.example', databases: ['app'], ...entry }])
      await $.tool.call({ tool: TOOL, action: 'open', filepath: `nouser-${label}.json` } as any)
      expect(w.runs).toEqual([])
      const ui: any = await $.ui.mount(PANE)
      await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
      expect(await ui.find({ key: 'trust-yes' })).toBeDefined()
      expect(w.runs).toEqual([])
    })
  }

  test('the agent tool refuses a config inside sessions/', async ($, on) => {
    const w = world(on, [{ id: 'x', name: 'X', host: 'h' }])
    w.files.set(`${BASE}/sessions/evil.json`, JSON.stringify({ servers: [{ id: 'x', name: 'X', host: 'evil', mysqlPath: '/tmp/evil' }] }))
    const r: any = await $.tool.call({ tool: TOOL, action: 'open', configfilepath: 'sessions/evil.json' } as any)
    expect(String(r?.result)).toContain('not sessions/')
    expect(w.runs).toEqual([])
  })

  test('the fingerprint changes when the host or the credential source changes', async () => {
    const a = normalizeServer({ id: 'x', host: 'a.example', username: 'u', passwordEnv: 'PW' })!
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ ...a, host: 'evil.example' }))
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ ...a, passwordEnv: 'GITHUB_TOKEN' }))
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ ...a, mysqlPath: '/tmp/evil' }))
  })
})

describe('writes', () => {
  const open = async ($: any, servers: unknown[], on: any, rows = 44) => {
    const w = world(on, servers)
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 'w.json' } as any)
    const ui: any = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } } })
    return { w, ui }
  }

  test('a write opens a prompt and runs nothing; Run once sends exactly it, outside the read-only session', async ($, on) => {
    const { w, ui } = await open($, [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }], on)
    await ui.post({ type: 'run', text: 'UPDATE users SET plan = 1 WHERE id = 7', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'write-once' })).toBeDefined()
    expect(w.mysql()).toEqual([])
    await ui.press({ key: 'write-once' })
    expect(w.mysql().length).toBe(1)
    const script = w.mysql()[0]!.stdin!
    expect(script).toContain('START TRANSACTION;\nUPDATE users SET plan = 1 WHERE id = 7;\nSELECT ROW_COUNT() AS affected_rows;\nCOMMIT;')
    expect(script).not.toContain('READ ONLY')
  })

  test('reads still run in the read-only session, with no prompt', async ($, on) => {
    const { w, ui } = await open($, [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }], on)
    await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'write-once' })).toBeUndefined()
    expect(w.mysql()[0]!.stdin).toContain('START TRANSACTION READ ONLY;')
  })

  test('DDL never prompts and never runs, unlocked or not', async ($, on) => {
    const { w, ui } = await open($, [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }], on)
    await ui.post({ type: 'run', text: 'DROP TABLE users', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'write-once' })).toBeUndefined()
    expect(w.mysql()).toEqual([])
  })

  test('production offers no session unlock; elsewhere it holds for the next write and ends with the entry', async ($, on) => {
    const { w, ui } = await open($, [{ id: 'prd', name: 'Prod', host: 'db.prd', tag: 'production', databases: ['app'] }, { id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }], on)
    await ui.post({ type: 'run', text: 'DELETE FROM t WHERE id = 1', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'write-once' })).toBeDefined()
    expect(await ui.find({ key: 'write-session' })).toBeUndefined()
    await ui.press({ key: 'write-cancel' })
    await ui.press({ key: 'server-menu' })
    await ui.press({ key: 'pick:dev' })
    await ui.post({ type: 'run', text: 'DELETE FROM t WHERE id = 1', row: 0 }, { in: 'editor' })
    await ui.press({ key: 'write-session' })
    await ui.post({ type: 'run', text: 'DELETE FROM t WHERE id = 2', row: 0 }, { in: 'editor' })
    // Picking the server also loads its schema (a read); the writes are what matters here.
    expect(w.writes().length).toBe(2)
    // The agent repoints the unlocked entry: the unlock is gone.
    w.files.set(`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'dev', name: 'Dev', host: 'db.prd', databases: ['app'] }] }))
    await ui.post({ type: 'run', text: 'DELETE FROM t WHERE id = 3', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'write-once' })).toBeDefined()
    expect(w.writes().length).toBe(2)
  })

  test('a long statement must be read to the end before Run appears', async ($, on) => {
    const { w, ui } = await open($, [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }], on, 20)
    const ids = Array.from({ length: 400 }, (_, i) => i).join(',\n  ')
    await ui.post({ type: 'run', text: `DELETE FROM t WHERE id IN (\n  ${ids}\n) OR 1 = 1`, row: 0 }, { in: 'editor' })
    let presses = 0
    while (await ui.find({ key: 'sql-next' })) {
      expect(await ui.find({ key: 'write-once' })).toBeUndefined()
      await ui.press({ key: 'sql-next' })
      presses++
    }
    expect(presses).toBeGreaterThan(5)
    expect(await ui.find({ key: 'write-once' })).toBeDefined()
    expect(w.mysql()).toEqual([])
  })

  test('the agent tool cannot run or unlock a write', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }])
    await $.tool.call({ tool: TOOL, action: 'open', filepath: 'agent.json' } as any)
    w.files.set(`${BASE}/sessions/agent.json`, JSON.stringify({ server: 'dev', database: 'app', cursorRow: 0, query: 'DELETE FROM t' }))
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 'agent.json' } as any)
    expect(w.mysql()).toEqual([])
  })
})

test('mysql reads only the mod option file, never ~/.my.cnf', async () => {
  const { argv } = mysqlInvocation({ id: 's', name: 's', host: 'h' }, undefined, '/usr/bin/mysql')
  expect(argv[2]).toContain('"$SQLC_MYSQL" --defaults-file=<(')
  expect(argv[2]).not.toContain('defaults-extra-file')
})
