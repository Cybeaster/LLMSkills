import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { safeLine } from '../evidence.js'
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// A row and everything below it, with a guard so a malformed tree cannot loop.
function subtreeIds(row: Row, seen = new Set<string>()): Set<string> {
  if (seen.has(row.sessionId)) return seen
  seen.add(row.sessionId)
  row.children.forEach(c => subtreeIds(c, seen))
  return seen
}

// A row stays when it matches or something below it does, so a matching child is shown under its ancestors.
function filterRows(rows: Row[], q: string): Row[] {
  const text = (r: Row) => `${r.name} ${r.title} ${r.cwd}`.toLowerCase()
  const walk = (rs: Row[]): Row[] =>
    rs.flatMap(r => {
      const children = walk(r.children)
      return children.length || text(r).includes(q) ? [{ ...r, children }] : []
    })
  return q ? walk(rows) : rows
}

export function App({
  initial,
  actions,
  interval = 3000,
  rows: screenRows,
  onQuit,
}: {
  initial?: Row[] // omitted: nothing is loaded yet, the first load shows "loading…"
  actions: Actions
  interval?: number
  rows?: number // terminal height; defaults to the real one
  onQuit?: (code: number) => void
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const height = screenRows ?? stdout?.rows ?? 24
  const [rows, setRows] = useState(initial ?? [])
  const [loaded, setLoaded] = useState(initial !== undefined)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  // the highlight follows the session (or task) it is on; the index is only the fallback when that one is gone
  const [cursor, setCursor] = useState(0)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [filter, setFilter] = useState('')
  const [typing, setTyping] = useState(false)
  const [message, setMessage] = useState('')
  const say = (m: unknown) => setMessage(safeLine(m))

  // One refresh at a time: a slow herdr or gh call must not stack up a new one every tick.
  const loading = useRef(false)
  const reload = () => {
    if (loading.current) return
    loading.current = true
    actions
      .load()
      .then(setRows, e => say(`refresh failed: ${errText(e)}`))
      .finally(() => {
        loading.current = false
        setLoaded(true)
      })
  }
  useEffect(() => {
    if (initial === undefined) reload()
    if (!interval) return
    const t = setInterval(reload, interval)
    return () => clearInterval(t)
  }, [interval])

  const all = flatten(rows).map(l => l.row)
  const lines = flatten(filterRows(rows, filter.toLowerCase()))
  const excluded = mode.kind === 'pick-parent' ? subtreeIds(all.find(r => r.sessionId === mode.child.sessionId) ?? mode.child) : new Set<string>()
  const parents = mode.kind === 'pick-parent' ? all.filter(r => !excluded.has(r.sessionId) && r.hasPool) : []
  const tasks = mode.kind === 'pick-task' ? mode.parent.tasks : []
  const ids = mode.kind === 'list' ? lines.map(l => l.row.sessionId) : mode.kind === 'pick-parent' ? parents.map(r => r.sessionId) : tasks.map(t => t.id)
  const size = ids.length
  const found = selectedId === undefined ? -1 : ids.indexOf(selectedId)
  const at = found >= 0 ? found : Math.min(cursor, Math.max(0, size - 1))
  const selected = mode.kind === 'list' ? lines[at]?.row : mode.kind === 'pool' ? all.find(r => r.sessionId === mode.id) : undefined

  const select = (i: number) => {
    const n = Math.max(0, Math.min(i, size - 1))
    setCursor(n)
    setSelectedId(ids[n])
  }
  const go = (m: Mode, sel?: string) => {
    setMode(m)
    setCursor(0)
    setSelectedId(sel)
    setMessage('')
  }
  const quit = (code: number) => {
    onQuit?.(code)
    exit()
  }

  // The window of rows that fits under the header and above the message and footer, kept where it was
  // until the cursor leaves it.
  const room = Math.max(3, height - 3)
  const top = useRef(0)
  top.current = Math.max(0, Math.min(top.current, size - room))
  if (at < top.current) top.current = at
  if (at >= top.current + room) top.current = at - room + 1
  const visible = (i: number) => i >= top.current && i < top.current + room

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return quit(130)
    if (typing) {
      if (key.escape) {
        setFilter('')
        setTyping(false)
      } else if (key.return) setTyping(false)
      else if (key.backspace || key.delete) setFilter(f => f.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setFilter(f => f + input)
      else return
      setCursor(0)
      setSelectedId(undefined)
      return
    }
    if (input === 'q') return quit(0)
    if (key.downArrow || input === 'j') return select(at + 1)
    if (key.upArrow || input === 'k') return select(at - 1)
    if (input === 'r') return void reload()

    if (mode.kind === 'list' || mode.kind === 'pool') {
      if (input === 'f' && selected) return void actions.focus(selected).then(say, e => say(errText(e)))
      if (input === 'o' && selected) return say(selected.link ?? 'no claude.ai link: this session is not on Remote Control')
    }
    if (mode.kind === 'list') {
      if (key.return && selected) return go({ kind: 'pool', id: selected.sessionId })
      if (input === '/') return setTyping(true)
      if (key.escape && filter) {
        setFilter('')
        setCursor(0)
        setSelectedId(undefined)
        return
      }
      if (input === 'l' && selected) return go({ kind: 'pick-parent', child: selected })
      return
    }
    if (mode.kind === 'pick-parent' && key.return && parents[at]) return go({ kind: 'pick-task', child: mode.child, parent: parents[at] })
    if (mode.kind === 'pick-task' && key.return && tasks[at]) {
      const { child, parent } = mode
      const taskId = tasks[at].id
      go({ kind: 'list' }, child.sessionId)
      return void actions.link(child, parent, taskId).then(
        m => {
          say(m)
          void reload()
        },
        e => say(errText(e)),
      )
    }
    if (key.escape || key.leftArrow || input === 'h') return go({ kind: 'list' }, mode.kind === 'pool' ? mode.id : mode.kind === 'pick-parent' ? mode.child.sessionId : undefined)
  })

  const filterNote = filter || typing ? `   filter: ${filter}${typing ? '▏' : ''}` : ''
  const pointer = (i: number) => (i === at ? '▸' : ' ')

  return (
    <Box flexDirection="column">
      <Text bold>{header(rows) + filterNote}</Text>
      {mode.kind === 'list' &&
        (lines.length ? (
          lines.map((l, i) =>
            visible(i) ? (
              <Text key={l.row.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${listLine(l)}`}</Text>
            ) : null,
          )
        ) : (
          <Text dimColor>{loaded ? 'no sessions' : 'loading…'}</Text>
        ))}
      {mode.kind === 'pool' &&
        (selected ? (
          poolLines(selected).map((s, i) => (
            <Text key={i} bold={i === 0} wrap="truncate-end">
              {s}
            </Text>
          ))
        ) : (
          <Text dimColor>this session is gone</Text>
        ))}
      {mode.kind === 'pick-parent' && (
        <>
          <Text>{`Attach ${mode.child.name} under which session?`}</Text>
          {parents.length ? (
            parents.map((r, i) =>
              visible(i) ? (
                <Text key={r.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${r.name}  ${shortCwd(r.cwd)}`}</Text>
              ) : null,
            )
          ) : (
            <Text dimColor>no session with a pool to attach under</Text>
          )}
        </>
      )}
      {mode.kind === 'pick-task' && (
        <>
          <Text>{`Which task of ${mode.parent.name}?`}</Text>
          {tasks.map((t, i) =>
            visible(i) ? (
              <Text key={t.id} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${t.id} ${t.text}`}</Text>
            ) : null,
          )}
        </>
      )}
      {message ? (
        <Text color="yellow" wrap="truncate-end">
          {message}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {mode.kind === 'list' ? FOOT.list : mode.kind === 'pool' ? FOOT.pool : FOOT.pick}
      </Text>
    </Box>
  )
}
