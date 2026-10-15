import { describe, expect, it } from 'vitest'
import { flatten, header, listLine, poolLines, renderList, shortCwd } from '../src/format.js'
import type { Row } from '../src/overview.js'

const row = (o: Partial<Row>): Row => ({
  sessionId: 's', name: 's', title: '', cwd: '/home/u/src/ItAbyss', state: 'idle', tag: 'herdr',
  hasPool: true, orphan: false, done: 0, total: 0, complete: false, flags: 0, tasks: [], children: [], ...o,
})

describe('format', () => {
  it('draws the tree prefixes', () => {
    const tree = [row({ name: 'p', children: [row({ name: 'a', children: [row({ name: 'x' })] }), row({ name: 'b' })] }), row({ name: 'q' })]
    expect(flatten(tree).map(l => l.prefix + l.row.name)).toEqual(['p', '├ a', '│ └ x', '└ b', 'q'])
  })

  it('shortens cwd', () => {
    expect(shortCwd('/home/u/src/ItAbyss/.worktrees/course-go', '/home/u')).toBe('ItAbyss/wt/course-go')
    expect(shortCwd('/home/u/notes', '/home/u')).toBe('~/notes')
  })

  it('renders a list line with progress, flags and state', () => {
    const line = listLine({ prefix: '', row: row({ name: 'beginner-courses', done: 2, total: 4, flags: 1 }) })
    expect(line).toMatch(/^beginner-courses\s+.*\s+idle\s+herdr\s+2\/4  ⚑1$/)
    expect(listLine({ prefix: '', row: row({ hasPool: false }) })).toMatch(/—  no pool$/)
    expect(listLine({ prefix: '', row: row({ done: 3, total: 3, complete: true }) })).toMatch(/3\/3 ✓$/)
  })

  it('counts live, flags and ended in the header', () => {
    expect(header([row({ flags: 2, children: [row({ state: 'ended' })] }), row({ state: 'busy' })])).toBe('ORCHESTRATOR  2 live · 2 ⚑ · 1 ended')
    expect(header([row({ state: 'waiting' })])).toBe('ORCHESTRATOR  1 live · 0 ⚑ · 0 ended')
    expect(listLine({ prefix: '', row: row({ state: 'waiting' }) })).toMatch(/\swaiting\s+herdr\s/)
  })

  it('adds the claude.ai link under a row in text output', () => {
    expect(renderList([row({ name: 'x', link: 'https://claude.ai/code/session_1' })])).toContain('→ https://claude.ai/code/session_1')
  })

  it('renders a pool', () => {
    const lines = poolLines(row({ name: 'p', title: 'Courses', tasks: [{ id: 't1', text: 'Write brief', status: 'done', mark: '✓', detail: 'commit 9f3e2a1' }] }))
    expect(lines[0]).toBe('p — Courses')
    expect(lines[1]).toMatch(/^✓ t1\s+Write brief\s+commit 9f3e2a1$/)
    expect(poolLines(row({ name: 'p', tasks: [] }))).toEqual(['p', '(no pool yet)'])
  })
})
