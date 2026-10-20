import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Real time, for a test that holds a process open: the engine's mock clock doesn't move I/O.
const pause = (ms: number) => new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, ms))

const TOOL = 'mcp__mysql-client__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`
const PANE = { plugin: 'mysql-client', surface: 'terminal', component: 'Pane', requestId: 'sql', props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 44 } }, viewport: { columns: 110, rows: 44 } } as any

function world(on: On, servers: unknown[]) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let clock = 1
  const mtimes = new Map<string, number>()
  let gate: Promise<void> | undefined
  let open: () => void = () => {}
  const w = {
    files, runs, mtimes, sameTick: false,
    hold() { gate = new Promise<void>(r => (open = r)) },
    release() { open(); gate = undefined },
    mysql: () => runs.filter(r => r.argv[0] === '/bin/bash'),
  }
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
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const isMysql = e.argv[0] === '/bin/bash'
    if (isMysql && gate) await gate
    return { value: { exitCode: 0, stdout: isMysql ? ((e.init?.stdin ?? '').includes(' AS c') ? 'c\n' + 'a'.repeat(60) + '\n' : 'x\n1\n') : 'clip\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  return w
}

const SERVERS = [{ id: 'local', name: 'Local', host: 'localhost', databases: ['app'] }]

test('a query still running when the console switches files is recorded in its own console', async ($, on) => {
  const w = world(on, SERVERS)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'a.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  w.hold()
  const p = ui.post({ type: 'run', text: 'SELECT 1 AS from_a', row: 0 }, { in: 'editor' })
  for (let i = 0; i < 20 && !w.mysql().length; i++) await pause(10)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'b.json' } as any)
  w.release()
  const pr = await p.then(() => 'resolved', (e: any) => 'rejected ' + String(e))
  for (let i = 0; i < 20; i++) await pause(10)
  const b = JSON.parse(w.files.get(`${BASE}/sessions/b.json`)!)
  const bres = w.files.get(`${BASE}/sessions/b.result.json`)
  const a = JSON.parse(w.files.get(`${BASE}/sessions/a.json`)!)
  expect(bres).toBeUndefined()
})

test('a drag pans the result at every step', async ($, on) => {
  world(on, SERVERS)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'pan.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.post({ type: 'run', text: "SELECT 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AS c", row: 0 }, { in: 'editor' })
  const lines = async () => JSON.stringify((await ui.find({ key: 'viewer' }))?.props?.props?.lines)
  const l0 = await lines()
  await ui.pointer({ type: 'down', x: 30, y: 1, button: 'left', in: 'viewer' })
  await ui.pointer({ type: 'move', x: 27, y: 1, button: 'left', in: 'viewer' })
  const l1 = await lines()
  await ui.pointer({ type: 'move', x: 24, y: 1, button: 'left', in: 'viewer' })
  await ui.pointer({ type: 'move', x: 21, y: 1, button: 'left', in: 'viewer' })
  const l2 = await lines()
  await ui.pointer({ type: 'up', x: 21, y: 1, button: 'left', in: 'viewer' })
  expect(l1).not.toBe(l0)
  expect(l2).not.toBe(l1)
})

test('ctrl+x copies the cut line', async ($, on) => {
  const w = world(on, SERVERS)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'cut.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.pointer({ type: 'down', x: 6, y: 1, button: 'left', in: 'editor' })
  await ui.pointer({ type: 'up', x: 6, y: 1, button: 'left', in: 'editor' })
  w.runs.length = 0
  await ui.key({ key: 'c', ctrl: true, in: 'editor' })
  w.runs.length = 0
  await ui.key({ key: 'x', ctrl: true, in: 'editor' })
  expect(w.runs.some(r => r.argv[0] === 'pbcopy')).toBe(true)
})

test('an agent write in the same mtime tick as the pane save is shown', async ($, on) => {
  const w = world(on, SERVERS)
  const file = `${BASE}/sessions/tick.json`
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'tick.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  // pane writes (format button -> scheduleSave) ; use a menu pick for a synchronous save
  await ui.press({ key: 'db-menu' })
  await ui.press({ key: 'pickdb:app' })
  const m = w.mtimes.get(file)!
  const st = JSON.parse(w.files.get(file)!)
  w.files.set(file, JSON.stringify({ ...st, query: 'SELECT 99 AS agent' })) // same mtime
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'tick.json' } as any) // runs sync
  const shown = JSON.stringify((await ui.find({ key: 'editor' }))?.props?.props?.text)
  expect(shown).toContain('SELECT 99')
})

test('a session file with a JSON typo is never replaced by the pane state', async ($, on) => {
  const w = world(on, SERVERS)
  const file = `${BASE}/sessions/typo.json`
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'typo.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  w.files.set(file, '{"server":"local","query":"SELECT 7 AS handwritten",}')
  w.mtimes.set(file, 5000)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'typo.json' } as any)
  await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
  expect(w.files.get(file)).toContain('handwritten')
})
