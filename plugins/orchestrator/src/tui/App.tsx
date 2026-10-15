import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { flatten, header, listLine, poolLines, shortCwd } from '../format.js'
import type { Row } from '../overview.js'

export type Actions = {
  load: () => Promise<Row[]>
  focus: (row: Row) => Promise<string>
  link: (child: Row, parent: Row, taskId: string) => Promise<string>
}

type Mode =
  | { kind: 'list' }
  | { kind: 'pool'; id: string }
  | { kind: 'pick-parent'; child: Row }
  | { kind: 'pick-task'; child: Row; parent: Row }

const FOOT = {
  list: '↑↓/jk move · enter open · f focus · o link · l attach under parent · / filter · r refresh · q quit',
  pool: 'esc/h back · f focus · o link · q quit',
  pick: 'enter choose · esc/h cancel',
}

export function App({ initial, actions, interval = 3000 }: { initial: Row[]; actions: Actions; interval?: number }) {
  const { exit } = useApp()
  const [rows, setRows] = useState(initial)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [typing, setTyping] = useState(false)
  const [message, setMessage] = useState('')

  // One refresh at a time: a slow herdr or gh call must not stack up a new one every tick.
  const loading = useRef(false)
  const reload = () => {
    if (loading.current) return
    loading.current = true
    actions
      .load()
      .then(setRows, e => setMessage(`refresh failed: ${e}`))
      .finally(() => {
        loading.current = false
      })
  }
  useEffect(() => {
    if (!interval) return
    const t = setInterval(reload, interval)
    return () => clearInterval(t)
  }, [interval])

  const all = flatten(rows).map(l => l.row)
  const lines = flatten(rows).filter(l => !filter || `${l.row.name} ${l.row.title} ${l.row.cwd}`.toLowerCase().includes(filter.toLowerCase()))
  const parents = mode.kind === 'pick-parent' ? all.filter(r => r.sessionId !== mode.child.sessionId && r.hasPool) : []
  const tasks = mode.kind === 'pick-task' ? mode.parent.tasks : []
  const size = mode.kind === 'list' ? lines.length : mode.kind === 'pick-parent' ? parents.length : tasks.length
  const at = Math.min(cursor, Math.max(0, size - 1))
  const selected = mode.kind === 'list' ? lines[at]?.row : mode.kind === 'pool' ? all.find(r => r.sessionId === mode.id) : undefined

  const go = (m: Mode) => {
    setMode(m)
    setCursor(0)
    setMessage('')
  }

  useInput((input, key) => {
    if (typing) {
      if (key.return || key.escape) setTyping(false)
      else if (key.backspace || key.delete) setFilter(f => f.slice(0, -1))
      else if (input) setFilter(f => f + input)
      return
    }
    if (input === 'q') return exit()
    if (key.downArrow || input === 'j') return setCursor(Math.min(at + 1, Math.max(0, size - 1)))
    if (key.upArrow || input === 'k') return setCursor(Math.max(at - 1, 0))
    if (input === 'r') return void reload()

    if (mode.kind === 'list' || mode.kind === 'pool') {
      if (input === 'f' && selected) return void actions.focus(selected).then(setMessage, e => setMessage(String(e)))
      if (input === 'o' && selected) return setMessage(selected.link ?? 'no claude.ai link: this session is not on Remote Control')
    }
    if (mode.kind === 'list') {
      if (key.return && selected) return go({ kind: 'pool', id: selected.sessionId })
      if (input === '/') return setTyping(true)
      if (input === 'l' && selected) return go({ kind: 'pick-parent', child: selected })
      return
    }
    if (mode.kind === 'pick-parent' && key.return && parents[at]) return go({ kind: 'pick-task', child: mode.child, parent: parents[at] })
    if (mode.kind === 'pick-task' && key.return && tasks[at]) {
      const { child, parent } = mode
      setMode({ kind: 'list' })
      return void actions.link(child, parent, tasks[at].id).then(
        m => {
          setMessage(m)
          void reload()
        },
        e => setMessage(String(e)),
      )
    }
    if (key.escape || key.leftArrow || input === 'h') return go({ kind: 'list' })
  })

  const filterNote = filter || typing ? `   filter: ${filter}${typing ? '▏' : ''}` : ''
  const pointer = (i: number) => (i === at ? '▸' : ' ')

  return (
    <Box flexDirection="column">
      <Text bold>{header(rows) + filterNote}</Text>
      {mode.kind === 'list' &&
        (lines.length ? (
          lines.map((l, i) => (
            <Text key={l.row.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${listLine(l)}`}</Text>
          ))
        ) : (
          <Text dimColor>no sessions</Text>
        ))}
      {mode.kind === 'pool' &&
        (selected ? poolLines(selected).map((s, i) => <Text key={i} bold={i === 0}>{s}</Text>) : <Text dimColor>this session is gone</Text>)}
      {mode.kind === 'pick-parent' && (
        <>
          <Text>{`Attach ${mode.child.name} under which session?`}</Text>
          {parents.map((r, i) => (
            <Text key={r.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${r.name}  ${shortCwd(r.cwd)}`}</Text>
          ))}
        </>
      )}
      {mode.kind === 'pick-task' && (
        <>
          <Text>{`Which task of ${mode.parent.name}?`}</Text>
          {tasks.map((t, i) => (
            <Text key={t.id} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${t.id} ${t.text}`}</Text>
          ))}
        </>
      )}
      {message ? <Text color="yellow">{message}</Text> : null}
      <Text dimColor>{mode.kind === 'list' ? FOOT.list : mode.kind === 'pool' ? FOOT.pool : FOOT.pick}</Text>
    </Box>
  )
}
