import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__sql-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/sql`

// A small in-memory world beneath the plugin: files, HOME and panes.
function world(on: On) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ name: 'stg', host: 'db.example', databases: ['app'] }] })]])
  const panes = new Set<string>()
  const opened: string[] = []
  let clock = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
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
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }
  })
  on('ui.open', ($, e) => {
    panes.add(e.id)
    opened.push(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  return { files, panes, opened }
}

const text = (r: any) => String(r?.result ?? r?.text ?? r?.deny ?? '')

describe('the console tool reads its arguments from the call', () => {
  test('status with a non-default filepath attaches that file and opens nothing', async ($, on) => {
    const w = world(on)
    const r = await $.tool.call({ tool: TOOL, action: 'status', filepath: 'isolated.json' } as any)
    expect(text(r)).toContain(`${BASE}/sessions/isolated.json`)
    expect(text(r)).not.toContain('default.json')
    expect(w.files.has(`${BASE}/sessions/isolated.json`)).toBe(true)
    expect(w.opened).toEqual([])
  })

  test('open with a filepath and configfilepath opens the pane on those files', async ($, on) => {
    const w = world(on)
    w.files.set(`${BASE}/other-servers.json`, JSON.stringify({ servers: [{ name: 'local', host: 'localhost', databases: ['app'] }] }))
    const r = await $.tool.call({ tool: TOOL, action: 'open', filepath: 'agent-7', configfilepath: 'other-servers.json' } as any)
    expect(text(r)).toContain(`${BASE}/sessions/agent-7.json`)
    expect(text(r)).toContain(`${BASE}/other-servers.json`)
    expect(w.opened).toEqual(['sql'])
  })

  test('close closes the pane', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: TOOL, action: 'open', filepath: 'x.json' } as any)
    expect(w.panes.has('sql')).toBe(true)
    const r = await $.tool.call({ tool: TOOL, action: 'close' } as any)
    expect(text(r)).toContain('closed')
    expect(w.panes.has('sql')).toBe(false)
  })

  test('a missing config file is reported, not silently replaced', async ($, on) => {
    world(on)
    const r = await $.tool.call({ tool: TOOL, action: 'status', configfilepath: 'nope.json' } as any)
    expect(text(r)).toContain('Config file not found')
  })
})
