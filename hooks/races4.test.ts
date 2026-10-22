import { expect, mock, test } from 'claude-code/testing'
const TOOL = 'mcp__mysql-client__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`
const FILE = `${BASE}/sessions/a.json`
const PANE = { plugin: 'mysql-client', surface: 'terminal', component: 'Pane', requestId: 'sql', props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 44 } }, viewport: { columns: 110, rows: 44 } } as any
// An outside writer saves the session file right after the pane's save has read it, `saves` times.
async function world($: any, on: any, saves: number, run = false) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }] })]])
  const mtimes = new Map<string, number>()
  const toasts: string[] = []
  let t = 1
  let armed = 0
  mock.env(on, { HOME }); mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', ($: any, e: any) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    const text = files.get(e.path)!
    if (e.path === FILE && armed > 0) {
      armed--
      files.set(FILE, JSON.stringify({ query: `SELECT ${3 + armed} AS concurrent_edit`, cursorRow: 0 }))
      mtimes.set(FILE, t++)
    }
    return { value: text }
  })
  on('fs.write', ($: any, e: any) => { files.set(e.path, e.text); mtimes.set(e.path, t++); return { value: undefined } })
  on('fs.stat', ($: any, e: any) => {
    if (!files.has(e.path) && e.path !== BASE && e.path !== `${BASE}/sessions`) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  // The outside saves start once the query has run, so they land on the save that records it.
  on('process.run', ($: any, e: any) => {
    if (e.argv[0] === '/bin/bash') armed = saves
    return { value: { exitCode: 0, stdout: 'x\n1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($: any, e: any) => { toasts.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'a.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  if (run) await ui.post({ type: 'run', text: 'SELECT 1', row: 0 }, { in: 'editor' })
  else {
    await ui.post({ type: 'edit', text: 'SELECT 1', row: 0 }, { in: 'editor' })
    armed = saves
  }
  await clock.advance(1000)
  return { files, toasts }
}
test('an outside save between the pane save read and write is kept', async ($, on) => {
  const w = await world($, on, 1)
  expect(JSON.parse(w.files.get(FILE)!).query).toBe('SELECT 3 AS concurrent_edit')
})
test('an outside save while a finished query is being recorded is kept, with lastRun added', async ($, on) => {
  const w = await world($, on, 1, true)
  const saved = JSON.parse(w.files.get(FILE)!)
  expect(saved.query).toBe('SELECT 3 AS concurrent_edit')
  expect(saved.lastRun).toBeDefined()
})
test('a file that keeps changing is never overwritten, and the pane says so', async ($, on) => {
  const w = await world($, on, 10, true)
  expect(JSON.parse(w.files.get(FILE)!).query).toContain('concurrent_edit')
  expect(w.toasts.join('\n')).toContain('keeps changing')
})
