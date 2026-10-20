import { expect, mock, test } from 'claude-code/testing'
const TOOL = 'mcp__mysql-client__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`
const PANE = { plugin: 'mysql-client', surface: 'terminal', component: 'Pane', requestId: 'sql', props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 44 } }, viewport: { columns: 110, rows: 44 } } as any
test('edits typed in console A just before a switch to B are saved to A', async ($, on) => {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'dev', name: 'Dev', host: 'db.dev', databases: ['app'] }] })]])
  const mtimes = new Map<string, number>()
  let t = 1
  mock.env(on, { HOME }); mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => { if (!files.has(e.path)) throw new Error('ENOENT'); return { value: files.get(e.path)! } })
  on('fs.write', ($, e) => { files.set(e.path, e.text); mtimes.set(e.path, t++); return { value: undefined } })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path) && e.path !== BASE && e.path !== `${BASE}/sessions`) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'a.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.post({ type: 'edit', text: 'SELECT 5 AS typed_in_a', row: 0 }, { in: 'editor' })
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'b.json' } as any)
  await clock.advance(1000)
  const a = JSON.parse(files.get(`${BASE}/sessions/a.json`)!)
  expect(a.query).toContain('typed_in_a')
})
