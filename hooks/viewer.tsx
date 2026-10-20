// Surface module: draws the window of result lines the hooks module hands
// it and posts keys and clicks back; row expansion and search live in the hooks module.
import type { ClientModule, ClientKeyEvent } from 'claude-code'

type Props = { lines: [string, string][][]; cursor: number; height: number; status: string }

const COLORS: Record<string, { color?: string; bold?: boolean; dimColor?: boolean; backgroundColor?: string }> = {
  k: { color: '#9cdcfe' },
  s: { color: '#ce9178' },
  n: { color: '#b5cea8' },
  b: { color: '#569cd6' },
  p: { dimColor: true },
  m: { dimColor: true },
  f: { color: '#c586c0' },
  e: { color: '#f14c4c' },
  H: { backgroundColor: '#614d00', color: '#ffffff' },
  C: { backgroundColor: '#d7a700', color: '#000000', bold: true },
  '': {},
}

const Viewer: ClientModule<Props, number> = (props, surface) => {
  const { Box, Text } = surface.elements

  surface.onKey((k: ClientKeyEvent) => surface.post({ type: 'key', key: k.key, ctrl: !!k.ctrl, shift: !!k.shift, meta: !!k.meta }))
  // Terminals don't pass a sideways swipe to mods, so dragging the result pans it: a press that
  // doesn't move is a click (open or close a row), one that moves left or right scrolls the columns.
  let press: { x: number; y: number; moved: boolean } | undefined
  surface.onPointer(ev => {
    if (ev.type === 'down' && ev.button === 'left') press = { x: ev.x, y: ev.y, moved: false }
    else if (ev.type === 'move' && press && ev.button === 'left' && ev.x !== press.x) {
      surface.post({ type: 'pan', by: press.x - ev.x })
      press = { ...press, x: ev.x, moved: true }
    } else if (ev.type === 'up' && press) {
      if (!press.moved && press.y < props.lines.length) surface.post({ type: 'click', y: press.y, x: press.x })
      press = undefined
    }
  })

  return (
    <Box flexDirection="column" height={props.height + 1}>
      {props.lines.map((segs, i) => (
        <Box height={1}>
          <Text wrap="truncate-end" backgroundColor={i === props.cursor ? '#264f78' : undefined}>
            {segs.map(([t, c]) => (
              <Text {...(COLORS[c] ?? {})}>{t}</Text>
            ))}
          </Text>
        </Box>
      ))}
      {props.lines.length < props.height && <Box height={props.height - props.lines.length} />}
      <Text dimColor wrap="truncate-end">
        {props.status}
      </Text>
    </Box>
  )
}

export default Viewer
