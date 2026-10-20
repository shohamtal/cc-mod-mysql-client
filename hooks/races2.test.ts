import { expect, mock, test } from 'claude-code/testing'

// Real time, for a test that holds a process open: the engine's mock clock doesn't move I/O.
const pause = (ms: number) => new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, ms))

const TOOL = 'mcp__mysql-client__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`
const PANE = { plugin: 'mysql-client', surface: 'terminal', component: 'Pane', requestId: 'sql', props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 44 } }, viewport: { columns: 110, rows: 44 } } as any

test('the pane\'s own delayed save, seen mid-write by the watcher, keeps the write prompt open', async ($, on) => {
  const file = `${BASE}/sessions/own.json`
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }] })]])
  const mtimes = new Map<string, number>()
  let t = 1
  let armed = false
  let slow = false
  let open: () => void = () => {}
  const gate = new Promise<void>(r => (open = r))
  mock.env(on, { HOME })
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: files.get(e.path)! }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, t++)
    if (armed && e.path === file) slow = true
    return { value: undefined }
  })
  on('fs.stat', async ($, e) => {
    if (!files.has(e.path) && e.path !== BASE && e.path !== `${BASE}/sessions`) throw new Error('ENOENT')
    if (slow && e.path === file) { slow = false; await gate }
    return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)

  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'own.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.post({ type: 'run', text: 'UPDATE t SET a = 1 WHERE id = 7', row: 0 }, { in: 'editor' })
  expect(await ui.find({ key: 'write-once' })).toBeDefined()
  armed = true
  void clock.advance(300) // the scheduled save: its write lands, its stat is slow
  await pause(30)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'own.json' } as any) // a watcher pass
  open()
  await pause(30)
  const still = await ui.find({ key: 'write-once' })
  expect(still).toBeDefined()
})
