// Surface module: the SQL editor. Keeps its text locally and posts every
// change to the hooks module; a new `rev` in props replaces the text.
import type { ClientModule, ClientKeyEvent } from 'claude-code'

type Props = { text: string; rev: number; height: number; row: number; paste?: { id: number; text: string }; schema?: Schema; runRows?: number[]; scroll?: { id: number; by: number }; cmd?: { id: number; cmd: 'undo' | 'redo' } }
type Pos = { row: number; col: number }
// What autocomplete knows: databases, their tables, and each table's columns (`db.table`).
export type Schema = { db: string; dbs: string[]; tables: Record<string, string[]>; cols: Record<string, string[]> }
type State = { lines: string[]; row: number; col: number; top: number; rev: number; anchor?: Pos; pasteId?: number; dragging?: boolean; sugSel?: number; sugHide?: string; scrollId?: number; cmdId?: number; hist?: Snap[]; fut?: Snap[]; group?: string }
type Snap = { lines: string[]; row: number; col: number }

const COLORS: Record<string, { color?: string; bold?: boolean; dimColor?: boolean }> = {
  kw: { color: '#569cd6', bold: true },
  fn: { color: '#dcdcaa' },
  id: { color: '#9cdcfe' },
  s: { color: '#ce9178' },
  n: { color: '#b5cea8' },
  b: { color: '#569cd6' },
  p: { dimColor: true },
  c: { color: '#6a9955' },
  '': {},
}

const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown',
  'home', 'end', 'escape', 'space',
])

export const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'AS', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING', 'LIMIT',
  'OFFSET', 'DISTINCT', 'UNION', 'ALL', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'SHOW', 'TABLES',
  'DATABASES', 'COLUMNS', 'DESCRIBE', 'EXPLAIN', 'INTERVAL', 'TRUE', 'FALSE', 'USING', 'OVER', 'PARTITION',
]
export const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'IFNULL', 'NULLIF', 'CONCAT', 'LOWER', 'UPPER', 'LENGTH',
  'SUBSTRING', 'TRIM', 'DATE', 'NOW', 'CURDATE', 'DATE_SUB', 'DATE_ADD', 'DATEDIFF', 'DATE_FORMAT', 'CAST',
  'ROUND', 'FLOOR', 'CEIL', 'ABS', 'GROUP_CONCAT', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'ROW_NUMBER', 'RANK',
]
const KW = new Set(KEYWORDS)
const FN = new Set(FUNCTIONS)

function lex(line: string): [string, string][] {
  const out: [string, string][] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, line.length)
      out.push([line.slice(i, j), c === '`' ? 'id' : 's'])
      i = j
    } else if (c === '#' || (c === '-' && line[i + 1] === '-' && (i + 2 >= line.length || /\s/.test(line[i + 2]!)))) {
      out.push([line.slice(i), 'c'])
      break
    } else if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      const j = end < 0 ? line.length : end + 2
      out.push([line.slice(i, j), 'c'])
      i = j
    } else if (/[0-9]/.test(c)) {
      const t = /^\d+(\.\d+)?/.exec(line.slice(i))![0]
      out.push([t, 'n'])
      i += t.length
    } else if (/[a-z_$]/i.test(c)) {
      const t = /^[a-z0-9_$]+/i.exec(line.slice(i))![0]
      const up = t.toUpperCase()
      const isCall = line.slice(i + t.length).trimStart().startsWith('(')
      out.push([t, KW.has(up) ? 'kw' : FN.has(up) && isCall ? 'fn' : /^(true|false|null)$/i.test(t) ? 'b' : ''])
      i += t.length
    } else if ('(),;.*=<>!+-/%'.includes(c)) {
      out.push([c, 'p'])
      i++
    } else {
      let j = i
      while (j < line.length && !/['"`#a-z0-9_$(),;.*=<>!+\-/%]/i.test(line[j]!)) j++
      if (j === i) j = i + 1
      out.push([line.slice(i, j), ''])
      i = j
    }
  }
  return out
}

// Control characters can't be drawn (the engine refuses the tree): tabs become two spaces,
// the rest are dropped. Applies to typed keys, pastes and text written into the session file.
const clean = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const init = (p: Props): State => {
  const lines = clean(p.text).split('\n')
  const row = Math.min(Math.max(0, p.row), lines.length - 1)
  return { lines, row, col: 0, top: Math.max(0, row - 2), rev: p.rev, pasteId: p.paste?.id, scrollId: p.scroll?.id, cmdId: p.cmd?.id }
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col)

// The selection as [start, end), or undefined when nothing is selected.
const range = (s: State): [Pos, Pos] | undefined => {
  if (!s.anchor) return undefined
  const cur = { row: s.row, col: s.col }
  if (s.anchor.row === cur.row && s.anchor.col === cur.col) return undefined
  return before(s.anchor, cur) ? [s.anchor, cur] : [cur, s.anchor]
}

const selectedText = (s: State): string => {
  const r = range(s)
  if (!r) return ''
  const [a, b] = r
  if (a.row === b.row) return s.lines[a.row].slice(a.col, b.col)
  return [s.lines[a.row].slice(a.col), ...s.lines.slice(a.row + 1, b.row), s.lines[b.row].slice(0, b.col)].join('\n')
}

const deleteSelection = (s: State): State => {
  const r = range(s)
  if (!r) return { ...s, anchor: undefined }
  const [a, b] = r
  const lines = [...s.lines]
  lines.splice(a.row, b.row - a.row + 1, lines[a.row].slice(0, a.col) + lines[b.row].slice(b.col))
  return { ...s, lines, row: a.row, col: a.col, anchor: undefined }
}

const insert = (s0: State, text: string): State => {
  const s = deleteSelection(s0)
  const lines = [...s.lines]
  const cur = lines[s.row]
  const parts = clean(text).split('\n')
  const head = cur.slice(0, s.col)
  const tail = cur.slice(s.col)
  if (parts.length === 1) {
    lines[s.row] = head + parts[0] + tail
    return { ...s, lines, col: s.col + parts[0].length }
  }
  const last = parts[parts.length - 1]
  lines.splice(s.row, 1, head + parts[0], ...parts.slice(1, -1), last + tail)
  return { ...s, lines, row: s.row + parts.length - 1, col: last.length }
}

type Suggest = { start: number; prefix: string; items: string[]; id: string }

// The statement around the cursor: from the last `;` before it to the next one.
function statementAround(s: State): { before: string; all: string } {
  const head = [...s.lines.slice(0, s.row), s.lines[s.row]!.slice(0, s.col)].join('\n')
  const tail = [s.lines[s.row]!.slice(s.col), ...s.lines.slice(s.row + 1)].join('\n')
  const before = head.slice(head.lastIndexOf(';') + 1)
  const after = tail.indexOf(';') < 0 ? tail : tail.slice(0, tail.indexOf(';'))
  return { before, all: before + after }
}

const unq = (x: string) => x.replace(/[`"]/g, '')

// Tables the statement reads, with their aliases: `FROM db.t a`, `JOIN t AS b`, `FROM a, b`.
function tablesIn(sql: string, schema: Schema): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\b(?:FROM|JOIN)\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?/gi
  for (const m of sql.matchAll(re)) {
    const ref = unq(m[1]!)
    const full = ref.includes('.') ? ref : `${schema.db}.${ref}`
    const alias = m[2] ? unq(m[2]) : undefined
    out.set(ref.split('.').pop()!.toLowerCase(), full)
    if (alias && !/^(where|on|join|left|right|inner|outer|cross|group|order|limit|having|union|using)$/i.test(alias)) out.set(alias.toLowerCase(), full)
  }
  return out
}

const rank = (names: readonly string[], prefix: string) => {
  const low = prefix.toLowerCase()
  const starts = names.filter(n => n.toLowerCase().startsWith(low) && n.toLowerCase() !== low)
  const inside = low ? names.filter(n => !n.toLowerCase().startsWith(low) && n.toLowerCase().includes(low)) : []
  return [...new Set([...starts, ...inside])]
}

// What fits where the cursor is: tables after FROM/JOIN, columns in SELECT/WHERE/ON/BY,
// `db.` → its tables, `alias.` → that table's columns, keywords otherwise.
export const suggest = (s: State, schema: Schema | undefined): Suggest | undefined => {
  if (!schema || s.anchor) return undefined
  const { before, all } = statementAround(s)
  const line = s.lines[s.row]!.slice(0, s.col)
  const m = /([`"]?[\w$]+[`"]?\.)?([\w$]*)$/.exec(line)!
  const prefix = m[2]!
  const qual = m[1] ? unq(m[1]).slice(0, -1) : undefined
  const start = s.col - prefix.length
  // Nothing inside a string or comment.
  const lastLine = before.split('\n').pop() ?? ''
  if ((lastLine.match(/'/g)?.length ?? 0) % 2 === 1 || /--(\s|$)|#/.test(lastLine.replace(/'[^']*'/g, ''))) return undefined
  let items: string[] = []
  const tables = tablesIn(all, schema)
  const colsOf = (full: string) => schema.cols[full] ?? []
  if (qual !== undefined) {
    if (schema.dbs.some(d => d.toLowerCase() === qual.toLowerCase())) items = rank(schema.tables[qual] ?? [], prefix)
    else {
      const full = tables.get(qual.toLowerCase()) ?? `${schema.db}.${qual}`
      items = rank(colsOf(full), prefix)
    }
  } else {
    if (!prefix) return undefined
    const words = before.replace(/'[^']*'/g, "''").match(/[A-Za-z_]+/g) ?? []
    const last = [...words].reverse().find(w => KW.has(w.toUpperCase()) && !/^(AS|AND|OR|NOT|IN|IS|NULL|LIKE|ASC|DESC|DISTINCT|ALL)$/i.test(w))?.toUpperCase()
    const tableNames = [...(schema.tables[schema.db] ?? []), ...schema.dbs]
    const columnNames = [...new Set([...tables.values()].flatMap(colsOf))]
    const kws = [...KEYWORDS, ...FUNCTIONS]
    if (last === 'FROM' || last === 'JOIN' || last === 'DESCRIBE' || last === 'TABLES') items = rank(tableNames, prefix)
    else if (last && /^(SELECT|WHERE|ON|BY|HAVING|WHEN|THEN|ELSE|CASE|BETWEEN)$/.test(last)) items = rank([...columnNames, ...kws], prefix)
    else items = rank(kws, prefix)
    if (/^[a-z]/.test(prefix)) items = items.map(i => (KW.has(i) || FN.has(i) ? i.toLowerCase() : i))
  }
  items = items.slice(0, 8)
  if (!items.length) return undefined
  const id = `${s.row}:${start}:${prefix}`
  if (s.sugHide === id) return undefined
  return { start, prefix, items, id }
}

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const prev = surface.state
  let st: State =
    prev && prev.rev === props.rev
      ? prev
      : prev
        ? { ...init(props), hist: [...(prev.hist ?? []), { lines: prev.lines, row: prev.row, col: prev.col }].slice(-200), fut: [] }
        : init(props)
  const height = Math.max(1, props.height)
  const gutter = String(st.lines.length).length + 3
  const runRows = new Set(props.runRows ?? [])

  const commit = (next: State, type = 'edit', group = '') => {
    if (type === 'edit' && next.sugSel === st.sugSel) next.sugSel = 0
    if (type === 'edit' && next.lines !== st.lines) {
      // Typing on one line is one undo step; any other edit is its own step.
      const same = group === 'type' && st.group === 'type' && next.row === st.row
      next.hist = same ? st.hist : [...(st.hist ?? []), { lines: st.lines, row: st.row, col: st.col }].slice(-200)
      next.fut = []
      next.group = group
    } else if (type === 'cursor') next.group = ''
    if (next.row < next.top) next.top = next.row
    if (next.row >= next.top + height) next.top = next.row - height + 1
    surface.setState(next)
    surface.post({ type, text: next.lines.join('\n'), row: next.row })
  }

  // A wheel tick the hooks module heard over the editor moves the window, not the cursor.
  if (props.scroll && props.scroll.id !== st.scrollId) {
    const maxTop = Math.max(0, st.lines.length - height)
    st = { ...st, top: Math.max(0, Math.min(maxTop, st.top + props.scroll.by)), scrollId: props.scroll.id }
    surface.setState(st)
  }

  const undo = (s: State): State | undefined => {
    const h = s.hist ?? []
    if (!h.length) return undefined
    const back = h[h.length - 1]!
    const next: State = { ...s, ...back, anchor: undefined, hist: h.slice(0, -1), fut: [...(s.fut ?? []), { lines: s.lines, row: s.row, col: s.col }], group: '' }
    commit(next, 'restore')
    return next
  }
  const redo = (s: State): State | undefined => {
    const f = s.fut ?? []
    if (!f.length) return undefined
    const fwd = f[f.length - 1]!
    const next: State = { ...s, ...fwd, anchor: undefined, fut: f.slice(0, -1), hist: [...(s.hist ?? []), { lines: s.lines, row: s.row, col: s.col }], group: '' }
    commit(next, 'restore')
    return next
  }

  // Undo / redo pressed on the pane's buttons arrive once each.
  if (props.cmd && props.cmd.id !== st.cmdId) {
    st = { ...st, cmdId: props.cmd.id }
    st = (props.cmd.cmd === 'undo' ? undo(st) : redo(st)) ?? st
    surface.setState(st)
  }

  // A paste the hooks module read from the clipboard (ctrl+v) lands once.
  if (props.paste && props.paste.id !== st.pasteId) {
    st = { ...insert(st, props.paste.text), pasteId: props.paste.id }
    commit(st)
  }

  surface.onKey((k: ClientKeyEvent) => {
    const s: State = st
    const sug = suggest(s, props.schema)
    if (sug && !k.ctrl && !k.meta && !k.shift) {
      const sel = Math.min(s.sugSel ?? 0, sug.items.length - 1)
      if (k.key === 'down' || k.key === 'up') {
        const n = (sel + (k.key === 'down' ? 1 : -1) + sug.items.length) % sug.items.length
        surface.setState({ ...s, sugSel: n })
        return
      }
      if (k.key === 'tab' || k.key === 'return' || k.key === 'enter') {
        const pick = sug.items[sel]!
        const lines = [...s.lines]
        const l = lines[s.row]!
        lines[s.row] = l.slice(0, sug.start) + pick + l.slice(s.col)
        const col = sug.start + pick.length
        return commit({ ...s, lines, col, sugSel: 0, sugHide: `${s.row}:${sug.start}:${pick}` })
      }
    }
    const line = s.lines[s.row]
    const key = k.key
    const text = () => s.lines.join('\n')
    if ((k.ctrl && (key === 'return' || key === 'enter' || key === 'r')) || (k.meta && key === 'return')) {
      surface.post({ type: 'run', text: text(), row: s.row })
      return
    }
    if ((k.ctrl || k.meta) && key === 'l') return surface.post({ type: 'format', text: text(), row: s.row })
    if ((k.ctrl || k.meta) && (key === 'z' || key === 'Z')) {
      void (k.shift || key === 'Z' ? redo(s) : undo(s))
      return
    }
    if ((k.ctrl || k.meta) && key === 'y') {
      void redo(s)
      return
    }
    if ((k.ctrl || k.meta) && key === 'a') {
      const last = s.lines.length - 1
      return commit({ ...s, anchor: { row: 0, col: 0 }, row: last, col: s.lines[last].length }, 'cursor')
    }
    if ((k.ctrl || k.meta) && (key === 'c' || key === 'x')) {
      const sel = selectedText(s) || line
      surface.post({ type: 'copy', copy: sel, text: text(), row: s.row })
      if (key === 'x') {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        lines.splice(s.row, 1)
        if (!lines.length) lines.push('')
        const row = Math.min(s.row, lines.length - 1)
        return commit({ ...s, lines, row, col: 0, anchor: undefined })
      }
      return
    }
    if ((k.ctrl || k.meta) && key === 'v') return surface.post({ type: 'paste', text: text(), row: s.row })

    // Movement; shift extends the selection from where it started.
    const move = (to: Pos) =>
      commit({ ...s, ...to, anchor: k.shift ? (s.anchor ?? { row: s.row, col: s.col }) : undefined }, 'cursor')
    const clamp = (row: number) => Math.min(s.col, s.lines[row].length)
    switch (key) {
      case 'up': { const row = Math.max(0, s.row - 1); return move({ row, col: clamp(row) }) }
      case 'down': { const row = Math.min(s.lines.length - 1, s.row + 1); return move({ row, col: clamp(row) }) }
      case 'pageup': { const row = Math.max(0, s.row - height); return move({ row, col: clamp(row) }) }
      case 'pagedown': { const row = Math.min(s.lines.length - 1, s.row + height); return move({ row, col: clamp(row) }) }
      case 'left': {
        const r = range(s)
        if (r && !k.shift) return move(r[0])
        if (s.col > 0) return move({ row: s.row, col: s.col - 1 })
        if (s.row > 0) return move({ row: s.row - 1, col: s.lines[s.row - 1].length })
        return move({ row: 0, col: 0 })
      }
      case 'right': {
        const r = range(s)
        if (r && !k.shift) return move(r[1])
        if (s.col < line.length) return move({ row: s.row, col: s.col + 1 })
        if (s.row < s.lines.length - 1) return move({ row: s.row + 1, col: 0 })
        return move({ row: s.row, col: s.col })
      }
      case 'home': return move({ row: s.row, col: 0 })
      case 'end': return move({ row: s.row, col: line.length })
      case 'tab': return commit(insert(s, '  '))
      case 'space': return commit(insert(s, ' '))
      case 'return':
      case 'enter': {
        const base = deleteSelection(s)
        const l = base.lines[base.row]
        const indent = /^\s*/.exec(l)![0]
        const prev = l.slice(0, base.col).trimEnd()
        const next = l.slice(base.col).trimStart()
        const opens = prev.endsWith('(')
        const closes = next.startsWith(')')
        if (opens && closes) {
          const inner = indent + '  '
          const n = insert(base, '\n' + inner + '\n' + indent)
          return commit({ ...n, row: n.row - 1, col: inner.length })
        }
        return commit(insert(base, '\n' + indent + (opens ? '  ' : '')))
      }
      case 'backspace': {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        if (s.col > 0) {
          const back = /^ +$/.test(line.slice(0, s.col)) && s.col % 2 === 0 ? 2 : 1
          lines[s.row] = line.slice(0, s.col - back) + line.slice(s.col)
          return commit({ ...s, lines, col: s.col - back, anchor: undefined })
        }
        if (s.row === 0) return
        const col = lines[s.row - 1].length
        lines.splice(s.row - 1, 2, lines[s.row - 1] + line)
        return commit({ ...s, lines, row: s.row - 1, col, anchor: undefined })
      }
      case 'delete': {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        if (s.col < line.length) lines[s.row] = line.slice(0, s.col) + line.slice(s.col + 1)
        else if (s.row < lines.length - 1) lines.splice(s.row, 2, line + lines[s.row + 1])
        else return
        return commit({ ...s, lines, anchor: undefined })
      }
    }
    if (k.ctrl) {
      if (key === 'e') return move({ row: s.row, col: line.length })
      if (key === 'k') {
        const lines = [...s.lines]
        lines[s.row] = line.slice(0, s.col)
        return commit({ ...s, lines, anchor: undefined })
      }
      return
    }
    if (k.meta || SPECIAL.has(key)) return
    // A character, or a paste arriving as one run of text.
    const typed = key
    const pairs: Record<string, string> = { '(': ')', "'": "'" }
    if (!range(s) && typed.length === 1 && pairs[typed] && (s.col === line.length || /[\s,)]/.test(line[s.col]!))) {
      if (!(typed === "'" && line[s.col] === "'")) {
        const n = insert(s, typed + pairs[typed])
        return commit({ ...n, col: n.col - 1 })
      }
    }
    if (!range(s) && typed.length === 1 && (typed === ')' || typed === "'") && line[s.col] === typed) {
      return commit({ ...s, col: s.col + 1 }, 'cursor')
    }
    return commit(insert(s, typed), 'edit', typed.length === 1 && typed !== ' ' ? 'type' : '')
  })

  surface.onPointer(ev => {
    const toPos = (): Pos => {
      const row = Math.max(0, Math.min(st.lines.length - 1, st.top + ev.y))
      return { row, col: Math.min(Math.max(0, ev.x - gutter), st.lines[row].length) }
    }
    if (ev.type === 'down' && ev.button === 'left') {
      const row = st.top + ev.y
      if (row < st.lines.length && ev.x < gutter - 1 && runRows.has(row)) {
        surface.post({ type: 'run', text: st.lines.join('\n'), row })
        return
      }
      const pos = toPos()
      const anchor = ev.shift ? (st.anchor ?? { row: st.row, col: st.col }) : pos
      commit({ ...st, ...pos, anchor, dragging: true }, 'cursor')
    } else if (ev.type === 'move' && st.dragging && ev.button === 'left') {
      const pos = toPos()
      if (pos.row !== st.row || pos.col !== st.col) commit({ ...st, ...pos }, 'cursor')
    } else if (ev.type === 'up' && st.dragging) {
      const next = { ...st, ...toPos(), dragging: false }
      commit(next, 'cursor')
      // Cmd+C belongs to the terminal and never reaches the pane, so a mouse selection copies itself.
      // Not when it looks like a secret, which would land in clipboard history; ctrl+c still copies it.
      const picked = selectedText(next)
      if (picked && !/IDENTIFIED\s+(BY|WITH)|PASSWORD/i.test(picked)) surface.post({ type: 'copy', copy: picked, auto: true, text: next.lines.join('\n'), row: next.row })
    }
  })

  const sel = range(st)
  const isSel = (r: number, c: number) =>
    !!sel && !before({ row: r, col: c }, sel[0]) && before({ row: r, col: c }, sel[1])

  const rows = []
  for (let r = st.top; r < Math.min(st.lines.length, st.top + height); r++) {
    const text = st.lines[r]
    const isReq = runRows.has(r)
    const num = String(r + 1).padStart(gutter - 3)
    const parts = []
    let pos = 0
    for (const [t, c] of lex(text)) {
      const style = COLORS[c] ?? {}
      // Split the token where cursor or selection changes the look.
      let buf = ''
      let look = ''
      const flush = () => {
        if (!buf) return
        parts.push(
          <Text {...style} inverse={look === 'cur' ? true : undefined} backgroundColor={look === 'sel' ? '#264f78' : undefined}>
            {buf}
          </Text>,
        )
        buf = ''
      }
      for (let i = 0; i < t.length; i++) {
        const col = pos + i
        const l = r === st.row && col === st.col ? 'cur' : isSel(r, col) ? 'sel' : ''
        if (l !== look) {
          flush()
          look = l
        }
        buf += t[i]
      }
      flush()
      pos += t.length
    }
    if (r === st.row && st.col >= text.length) parts.push(<Text inverse> </Text>)
    else if (sel && isSel(r, text.length)) parts.push(<Text backgroundColor="#264f78"> </Text>)
    rows.push(
      <Box flexDirection="row" height={1}>
        <Text color={isReq ? '#4ec9b0' : undefined} dimColor={!isReq}>
          {isReq ? '▶' : ' '}
          {num}{' '}
        </Text>
        <Text wrap="truncate-end">{parts}</Text>
      </Box>,
    )
  }
  const sug = suggest(st, props.schema)
  let popup = null
  if (sug) {
    const sel = Math.min(st.sugSel ?? 0, sug.items.length - 1)
    const width = Math.min(60, Math.max(...sug.items.map(i => i.length)) + 4)
    const y = st.row - st.top
    const below = y + 1 + sug.items.length + 2 <= height
    popup = (
      <Box
        position="absolute"
        top={below ? y + 1 : Math.max(0, y - sug.items.length - 2)}
        left={gutter + sug.start}
        width={width}
        flexDirection="column"
        borderStyle="round"
        borderColor="#4ec9b0"
        backgroundColor="#1e1e1e"
      >
        {sug.items.map((item, i) => (
          <Text wrap="truncate-end" inverse={i === sel ? true : undefined} color={i === sel ? undefined : '#dcdcaa'}>
            {item}
          </Text>
        ))}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" height={height}>
      {rows}
      {popup}
    </Box>
  )
}

export default Editor
