import { expect, test } from 'claude-code/testing'

test('the pane draws on the terminal', async $ => {
  const ui = await $.ui.mount({
    plugin: 'sql-console',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sql',
    props: { title: 'SQL', isFocused: true, bodyColumns: 110, placement: 'dock' } as any,
    viewport: { columns: 110, rows: 40 } as any,
  })
  expect(await ui.find({ key: 'schema' })).toBeDefined()
  expect(await ui.find({ key: 'search' })).toBeDefined()
})
