import { describe, expect, it } from 'vitest'
import { flatten, header, listLine, poolLines, renderList, shortCwd } from '../src/format.js'
import type { Row } from '../src/overview.js'
import { width as stringWidth } from '../src/width.js'

const row = (o: Partial<Row>): Row => ({
  sessionId: 's', name: 's', title: '', cwd: '/home/u/src/ItAbyss', state: 'idle', tag: 'herdr',
  hasPool: true, orphan: false, done: 0, total: 0, complete: false, touchedAt: 0, flags: 0, tasks: [], children: [], ...o,
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

  it('only rewrites the home prefix of a path', () => {
    expect(shortCwd('/mnt/home/u/src/x', '/home/u')).toBe('/mnt/home/u/src/x')
    expect(shortCwd('/mnt/home/u/notes', '/home/u')).toBe('/mnt/home/u/notes')
    expect(shortCwd('/srv/home/u/', '/home/u')).toBe('/srv/home/u/')
    expect(shortCwd('/home/u', '/home/u')).toBe('~')
    expect(shortCwd('/home/user/src/x', '/home/u')).toBe('/home/user/src/x')
    expect(shortCwd('/home/u/src/a/b', '/home/u')).toBe('a/b')
    expect(shortCwd('/opt/p/.worktrees/w', '/home/u')).toBe('/opt/p/wt/w')
    expect(shortCwd('', '/home/u')).toBe('')
  })

  it('clips a long name or path with an ellipsis', () => {
    const line = listLine({ prefix: '', row: row({ name: 'n'.repeat(30), cwd: '/srv/' + 'c'.repeat(40) }) })
    expect(line.startsWith(`${'n'.repeat(23)}… `)).toBe(true)
    expect(line).toContain(` /srv/${'c'.repeat(16)}… `)
    expect(line).not.toContain('n'.repeat(24))
  })

  it('clips by display width, so an emoji is never cut in half', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    const line = listLine({ prefix: '', row: row({ name: `${'n'.repeat(22)}😀tail` }) })
    expect(line.startsWith(`${'n'.repeat(22)}… `)).toBe(true)
    expect(lone.test(line)).toBe(false)
    const short = listLine({ prefix: '', row: row({ name: '😀'.repeat(3) }) })
    expect(short.startsWith(`😀😀😀${' '.repeat(18)} `)).toBe(true)
    const text = poolLines(row({ name: 'p', tasks: [{ id: 't1', text: `${'w'.repeat(33)}😀😀`, status: 'pending', mark: '·', detail: '' }] }))[1]
    expect(text).toBe(`· t1   ${'w'.repeat(33)}…`)
    expect(lone.test(text)).toBe(false)
  })

  it('shows orphan and unreadable pool in the list', () => {
    expect(listLine({ prefix: '', row: row({ orphan: true, done: 1, total: 2 }) })).toMatch(/1\/2  orphan$/)
    expect(listLine({ prefix: '', row: row({ unreadable: 'Unexpected token', hasPool: false }) })).toMatch(/ unreadable pool$/)
    expect(listLine({ prefix: '', row: row({ unreadable: 'x', hasPool: false, flags: 1, orphan: true }) })).toMatch(/unreadable pool  ⚑1  orphan$/)
  })

  it('counts flags once: from top-level rows, which already include their children', () => {
    // buildOverview rolls a child's flags up, so the parent's 2 is its own 1 plus the child's 1
    const rows = [row({ flags: 2, children: [row({ flags: 1 })] }), row({ flags: 1 })]
    expect(header(rows)).toBe('ORCHESTRATOR  3 live · 3 ⚑ · 0 ended')
  })

  it('says why a pool cannot be shown', () => {
    expect(poolLines(row({ name: 'p', unreadable: 'Unexpected token' }))).toEqual(['p', 'unreadable pool: Unexpected token'])
    expect(poolLines(row({ name: 'p', title: 'Courses', unreadable: 'bad' }))).toEqual(['p — Courses', 'unreadable pool: bad'])
  })

  it('leaves the title off the pool head when it repeats the name', () => {
    expect(poolLines(row({ name: 'beginner-courses', title: 'beginner-courses' }))[0]).toBe('beginner-courses')
    expect(poolLines(row({ name: 'a', title: 'b' }))[0]).toBe('a — b')
  })
})

describe('display width', () => {
  const cols = (line: string) => stringWidth(line.slice(0, line.indexOf('idle')))
  it('keeps the columns aligned for CJK and emoji names', () => {
    const widths = ['plain', '日本語セッション', '🚀 rocket', 'a'.repeat(40)].map(name => cols(listLine({ prefix: '', row: row({ name }) })))
    expect(new Set(widths).size).toBe(1)
  })

  it('never cuts a wide character in half', () => {
    const line = listLine({ prefix: '', row: row({ name: '日本語日本語日本語日本語日本語日本語' }) })
    expect(line).toContain('…')
    expect(stringWidth(line.slice(0, line.indexOf('idle')))).toBe(24 + 1 + 22 + 1)
  })
})
