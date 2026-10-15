import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkKey, type Check } from '../src/evidence.js'
import { header, flatten } from '../src/format.js'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, DAY, type OverviewInput, type Row } from '../src/overview.js'
import type { HerdrAgent } from '../src/sources/herdr.js'
import type { LiveSession } from '../src/sources/sessions.js'
import { listPools } from '../src/store.js'

const NOW = 10 * DAY

function pool(id: string, tasks: Partial<Task>[], extra: Partial<Pool> = {}): Pool {
  return {
    ...newPool(id, `/src/${id}`, NOW - 1000),
    tasks: tasks.map((t, i) => ({ id: `t${i + 1}`, text: `task ${i + 1}`, status: 'pending', ...t })),
    ...extra,
  }
}
const live = (sessionId: string, extra: Partial<LiveSession> = {}): LiveSession => ({ pid: 1, sessionId, cwd: `/src/${sessionId}`, status: 'idle', ...extra })
const agent = (sessionId: string, name: string): HerdrAgent => ({ sessionId, name, paneId: `p-${name}`, status: 'idle' })

function input(over: Partial<OverviewInput>): OverviewInput {
  return { pools: [], live: [], agents: [], checks: new Map<string, Check>(), now: NOW, ...over }
}

describe('buildOverview', () => {
  it('sorts names with numbers in numeric order', () => {
    const names = ['s10', 's2', 's1']
    const rows = buildOverview(input({ live: names.map(n => live(n)), agents: names.map(n => agent(n, n)) }))
    expect(rows.map(r => r.name)).toEqual(['s1', 's2', 's10'])
  })

  it('nests children under their parent and rolls up flags', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ status: 'done', evidence: { kind: 'commit', ref: 'abc' } }, { children: ['C1', 'C2'], status: 'in_progress' }], { title: 'Courses' }) },
        { id: 'C1', pool: pool('C1', [{ status: 'done', evidence: { kind: 'commit', ref: 'x' } }], { parent: { sessionId: 'P', taskId: 't2' } }) },
        { id: 'C2', pool: pool('C2', [{ needsInput: 'which curve?' }], { parent: { sessionId: 'P', taskId: 't2' } }) },
      ],
      live: [live('P'), live('C1'), live('C2', { status: 'busy' })],
      agents: [agent('P', 'beginner-courses'), agent('C1', 'course-go'), agent('C2', 'course-python')],
    }))
    expect(rows).toHaveLength(1)
    const [p] = rows
    expect(p).toMatchObject({ name: 'beginner-courses', title: 'Courses', tag: 'herdr', flags: 1, done: 1, total: 2 })
    expect(p.children.map(c => c.name)).toEqual(['course-go', 'course-python'])
    expect(p.tasks[1]).toMatchObject({ status: 'in_progress', mark: '◐', detail: '2 children: 1 ✓ 1 running' })
    expect(p.children[1].tasks[0]).toMatchObject({ mark: '⚑', detail: '"which curve?"' })
  })

  it('counts a parent task done once every child pool is done, and not before', () => {
    const child = (id: string, status: 'done' | 'pending') => ({ id, pool: pool(id, [{ status, evidence: { kind: 'commit' as const, ref: 'a' } }], { parent: { sessionId: 'P', taskId: 't1' } }) })
    const make = (s: 'done' | 'pending') => buildOverview(input({
      pools: [{ id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) }, child('C', s)],
      live: [live('P'), live('C')],
    }))[0]
    expect(make('done')).toMatchObject({ done: 1, total: 1, complete: true })
    expect(make('done').tasks[0].mark).toBe('✓')
    expect(make('pending').tasks[0].status).toBe('in_progress')
  })

  it('grades evidence with the live checks', () => {
    const checks = new Map<string, Check>([
      [checkKey({ kind: 'ci', ref: 'u1' }, '/src/S'), 'fail'],
      [checkKey({ kind: 'pr', ref: '4' }, '/src/S'), 'pending'],
      [checkKey({ kind: 'pr', ref: '4' }, '/src/other'), 'fail'],
    ])
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { status: 'done', evidence: { kind: 'ci', ref: 'u1' } },
        { status: 'done', evidence: { kind: 'pr', ref: '4' } },
        { status: 'done' },
        { status: 'blocked', blockedReason: 'needs key' },
      ]) }],
      live: [live('S')],
      checks,
    }))
    expect(row.tasks.map(t => t.mark)).toEqual(['✗', '?', '~', '!'])
    expect(row.tasks[0].detail).toBe('ci u1 ✗ failing (live)')
    expect(row.tasks[1].detail).toBe('pr 4 (unverified)')
    expect(row.tasks[2].detail).toBe('claimed, no evidence')
    expect(row.tasks[3].detail).toBe('needs key')
  })

  it('clips long evidence but keeps the live verdict', () => {
    const url = 'https://github.com/kvalitskii/ClaudeSkills/actions/runs/12345678901'
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { status: 'done', evidence: { kind: 'ci', ref: url } },
        { status: 'done', evidence: { kind: 'note', ref: 'x'.repeat(80) } },
      ]) }],
      live: [live('S')],
      checks: new Map<string, Check>([[checkKey({ kind: 'ci', ref: url }, '/src/S'), 'fail']]),
    }))
    expect(row.tasks[0].detail).toMatch(/… ✗ failing \(live\)$/)
    expect(row.tasks[1].detail).toHaveLength(40)
    expect(row.tasks[1].detail).toMatch(/x…$/)
  })

  it('tags sessions outside herdr as external and links Remote Control sessions', () => {
    const [row] = buildOverview(input({ live: [live('S', { name: 'api-fix', bridgeSessionId: 'session_01X', pid: 77 })], agents: [] }))
    expect(row).toMatchObject({ name: 'api-fix', tag: 'external', hasPool: false, link: 'https://claude.ai/code/session_01X', pid: 77 })
  })

  it('shows a session blocked on a dialog as waiting', () => {
    const [row] = buildOverview(input({ live: [live('S', { waitingFor: 'dialog open' })] }))
    expect(row).toMatchObject({ state: 'waiting', waitingFor: 'dialog open' })
  })

  it('drops ended sessions after a day unless their parent is live', () => {
    const old = (id: string, extra: Partial<Pool> = {}) => ({ id, pool: pool(id, [{}], { updatedAt: NOW - 2 * DAY, ...extra }) })
    const rows = buildOverview(input({
      pools: [old('gone'), old('kept', { parent: { sessionId: 'P', taskId: 't1' } }), { id: 'P', pool: pool('P', [{ children: ['kept'] }]) }],
      live: [live('P')],
    }))
    expect(rows.map(r => r.sessionId)).toEqual(['P'])
    expect(rows[0].children[0]).toMatchObject({ sessionId: 'kept', state: 'ended', tag: '—' })
  })

  it('survives a parent cycle and shows every member exactly once', () => {
    const p = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    // B and C are each other's parent; A and T hang off B; S is its own parent. A comes first in `ids`.
    const rows = buildOverview(input({
      pools: [p('A', 'B'), p('B', 'C'), p('C', 'B'), p('S', 'S'), p('T', 'B')],
      live: [live('A'), live('B'), live('C'), live('S'), live('T')],
    }))
    const count = (rs: Row[]): number => rs.reduce((n, r) => n + 1 + count(r.children), 0)
    expect(count(rows)).toBe(5)
    expect(flatten(rows).map(l => l.row.sessionId).sort()).toEqual(['A', 'B', 'C', 'S', 'T'])
    expect(header(rows)).toMatch(/ 5 live /)
  })

  it('shows a long tail hanging off a cycle once, whatever order it is listed in', () => {
    const p = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    // E -> D -> A -> B <-> C
    const pools = [p('E', 'D'), p('D', 'A'), p('A', 'B'), p('B', 'C'), p('C', 'B')]
    for (const order of [['E', 'D', 'A', 'B', 'C'], ['C', 'B', 'A', 'D', 'E'], ['D', 'C', 'E', 'A', 'B']]) {
      const rows = buildOverview(input({ pools, live: order.map(id => live(id)) }))
      expect(flatten(rows).map(l => l.row.sessionId).sort(), order.join()).toEqual(['A', 'B', 'C', 'D', 'E'])
      expect(rows, order.join()).toHaveLength(1)
    }
  })

  it('keeps ordinary roots as they are next to a cycle', () => {
    const p = (id: string, parent?: string) => ({ id, pool: pool(id, [{}], parent ? { parent: { sessionId: parent, taskId: 't1' } } : {}) })
    const rows = buildOverview(input({
      pools: [p('R'), p('K', 'R'), p('X', 'Y'), p('Y', 'X')],
      live: [live('Y'), live('K'), live('R'), live('X')],
    }))
    const r = rows.find(row => row.sessionId === 'R')!
    expect(r.children.map(c => c.sessionId)).toEqual(['K'])
    expect(flatten(rows).map(l => l.row.sessionId).sort()).toEqual(['K', 'R', 'X', 'Y'])
  })

  it('marks orphans and unreadable pools', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'O', pool: pool('O', [{}], { parent: { sessionId: 'missing', taskId: 't1' } }) }, { id: 'B', error: 'Unexpected token' }],
      live: [live('O'), live('B')],
    }))
    expect(rows.find(r => r.sessionId === 'O')!.orphan).toBe(true)
    expect(rows.find(r => r.sessionId === 'B')!.unreadable).toBe('Unexpected token')
  })

  it('puts sessions with open questions first, ended last', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'a', pool: pool('a', [{}], { title: 'a' }) },
        { id: 'b', pool: pool('b', [{ needsInput: 'q' }], { title: 'b' }) },
        { id: 'c', pool: pool('c', [{}], { title: 'c' }) },
      ],
      live: [live('a'), live('b')],
    }))
    expect(rows.map(r => r.sessionId)).toEqual(['b', 'a', 'c'])
  })

  it('keeps a session name, title, question and task text on one line without escape codes', () => {
    const evil = (s: string) => `${s}\n${s}\u001b]0;x\u0007${s}`
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { text: 'fix\nthe\u001b]0;x\u0007bug', needsInput: 'which\ncurve\u001b]0;x\u0007?' },
        { status: 'blocked', blockedReason: 'needs\nkey\u001b]0;x\u0007' },
      ], { title: evil('t') }) }],
      live: [live('S', { waitingFor: 'dialog\nopen\u001b]0;x\u0007' })],
      agents: [agent('S', 'bad\nname\u001b]0;x\u0007')],
    }))
    expect(row.tasks[0].text).toBe('fix the ]0;x bug')
    expect(row.tasks[0].detail).toBe('"which curve ]0;x ?"')
    expect(row.tasks[1].detail).toBe('needs key ]0;x')
    expect(row.name).toBe('bad name ]0;x')
    expect(row.title).toBe('t t ]0;x t')
    expect(row.waitingFor).toBe('dialog open ]0;x')
    for (const text of [row.name, row.title, row.waitingFor!, ...row.tasks.flatMap(t => [t.text, t.detail])]) {
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
  })

  describe('keeps what a session wrote on one line', () => {
    const evil = 'a\nb\u001b]0;x\u0007'
    const titled = { id: 'S', pool: pool('S', [{}], { title: evil }) }
    const cases: [string, Partial<OverviewInput>, 'name' | 'title'][] = [
      ['a herdr name', { live: [live('S')], agents: [agent('S', evil)] }, 'name'],
      ['a session name', { live: [live('S', { name: evil })] }, 'name'],
      ['a pool title used as the name', { pools: [titled], live: [live('S')] }, 'name'],
      ['the start of the session id used as the name', { live: [live(`${evil}cdef`)] }, 'name'],
      ['a pool title', { pools: [titled], live: [live('S')] }, 'title'],
      ['a herdr title', { live: [live('S')], agents: [{ ...agent('S', 'n'), title: evil }] }, 'title'],
    ]
    it.each(cases)('%s', (_what, over, field) => {
      const [row] = buildOverview(input(over))
      expect(row[field]).toBe('a b ]0;x')
    })
  })

  it('keeps the reason a pool is unreadable on one line', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'B', error: 'bad\njson\u001b]0;x\u0007 here' }, { id: 'G', pool: pool('G', [{}]) }],
      live: [live('B'), live('G')],
    }))
    expect(rows.find(r => r.sessionId === 'B')!.unreadable).toBe('bad json ]0;x here')
    expect(rows.find(r => r.sessionId === 'G')!.unreadable).toBeUndefined()
  })

  it('keeps the error of a real broken pool file on one line', () => {
    // V8 quotes the start of the bad JSON in its message, so a session can get its own bytes into it
    const home = mkdtempSync(join(tmpdir(), 'orch-overview-'))
    try {
      writeFileSync(join(home, 's1.json'), '{"a":\n\u001b]0;x\u0007')
      const [entry] = listPools(home)
      expect(entry.error).toMatch(/[\u0000-\u001f]/)
      const [row] = buildOverview(input({ pools: [entry], live: [live('s1')] }))
      expect(row.unreadable).toContain('is not valid JSON')
      expect(row.unreadable).not.toMatch(/[\u0000-\u001f\u007f]/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('clips evidence by code point, so an emoji at the cut is not split', () => {
    // 'note: ' + 32 x is 38 columns and the emoji is 2 wide, so it would end at column 40; the clip keeps 39 columns and adds the ellipsis
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ status: 'done', evidence: { kind: 'note', ref: `${'x'.repeat(32)}😀tail` } }]) }],
      live: [live('S')],
    }))
    expect(row.tasks[0].detail).toBe(`note: ${'x'.repeat(32)}…`)
    expect(row.tasks[0].detail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('replaces control characters in a cwd but keeps its spaces', () => {
    const dirty = '/src/my project\n\u001b]0;x\u0007/sub dir'
    const clean = '/src/my project??]0;x?/sub dir'
    const [fromPool] = buildOverview(input({ pools: [{ id: 'S', pool: pool('S', [{}], { cwd: dirty }) }], live: [live('S')] }))
    const [fromSession] = buildOverview(input({ live: [live('S', { cwd: dirty })] }))
    expect(fromPool.cwd).toBe(clean)
    expect(fromSession.cwd).toBe(clean)
    expect(fromPool.cwd).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('still looks up checks by the real cwd of the pool', () => {
    const cwd = '/src/my project\u001b'
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ status: 'done', evidence: { kind: 'ci', ref: 'u1' } }], { cwd }) }],
      live: [live('S')],
      checks: new Map<string, Check>([[checkKey({ kind: 'ci', ref: 'u1' }, cwd), 'fail']]),
    }))
    expect(row.tasks[0].mark).toBe('✗')
  })

  it('does not clip a question or a blocked reason', () => {
    const long = 'q'.repeat(120)
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ needsInput: long }, { status: 'blocked', blockedReason: long }]) }],
      live: [live('S')],
    }))
    expect(row.tasks[0].detail).toBe(`"${long}"`)
    expect(row.tasks[1].detail).toBe(long)
  })

  it('falls back to the next name when one is blank', () => {
    const name = (a: string, s: string | undefined, title: string, id = 'abcdefghijkl') => {
      const [row] = buildOverview(input({
        pools: [{ id, pool: pool(id, [{}], { title }) }],
        live: [live(id, { name: s })],
        agents: [agent(id, a)],
      }))
      return row.name
    }
    expect(name('', 'api-fix', 'Courses')).toBe('api-fix')
    expect(name('', '', 'Courses')).toBe('Courses')
    expect(name('', '', '')).toBe('abcdefgh')
    expect(name('  \n', undefined, 'Courses')).toBe('Courses')
    expect(name('herdr-name', 'api-fix', 'Courses')).toBe('herdr-name')
  })

  it('is not complete, and does not finish its parent task, while a child pool is still empty', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) },
        { id: 'C', pool: pool('C', [], { parent: { sessionId: 'P', taskId: 't1' } }) },
      ],
      live: [live('P'), live('C')],
    }))
    const [p] = rows
    expect(p.tasks[0]).toMatchObject({ status: 'in_progress', detail: '1 children: 0 ✓ 1 running' })
    expect(p).toMatchObject({ done: 0, total: 1, complete: false })
    expect(p.children[0]).toMatchObject({ hasPool: false, total: 0, complete: false })
  })

  it('is complete only once every child is, not just some of them', () => {
    const make = (second: 'done' | 'pending') => buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C1', 'C2'] }]) },
        { id: 'C1', pool: pool('C1', [{ status: 'done', evidence: { kind: 'commit', ref: 'a' } }], { parent: { sessionId: 'P', taskId: 't1' } }) },
        { id: 'C2', pool: pool('C2', [{ status: second, evidence: { kind: 'commit', ref: 'b' } }], { parent: { sessionId: 'P', taskId: 't1' } }) },
      ],
      live: [live('P'), live('C1'), live('C2')],
    }))[0]
    expect(make('pending')).toMatchObject({ complete: false, done: 0, total: 1 })
    expect(make('pending').tasks[0]).toMatchObject({ status: 'pending', detail: '2 children: 1 ✓ 1 running' })
    expect(make('done')).toMatchObject({ complete: true, done: 1, total: 1 })
  })

  it('judges completeness the same whatever order the sessions are listed in', () => {
    // C's own task says done, but its child G is not: C is not complete, so P's task is not done.
    // C has no parent link, so whether C is built before P depends on the order of `ids`.
    const pools = [
      { id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) },
      { id: 'C', pool: pool('C', [{ children: ['G'], status: 'done' }]) },
      { id: 'G', pool: pool('G', [{ status: 'pending' }]) },
    ]
    const a = buildOverview(input({ pools, live: [live('P'), live('C'), live('G')] }))
    const b = buildOverview(input({ pools, live: [live('G'), live('C'), live('P')] }))
    const c = buildOverview(input({ pools: [...pools].reverse(), live: [live('C'), live('P'), live('G')] }))
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    const p = a.find(r => r.sessionId === 'P')!
    expect(p.tasks[0].status).toBe('in_progress')
    expect(p).toMatchObject({ done: 0, complete: false })
    expect(a.find(r => r.sessionId === 'C')).toMatchObject({ complete: false, done: 0 })
  })

  it('counts a chain of finished children as complete all the way up', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C'] }]) },
        { id: 'C', pool: pool('C', [{ children: ['G'] }], { parent: { sessionId: 'P', taskId: 't1' } }) },
        { id: 'G', pool: pool('G', [{ status: 'done', evidence: { kind: 'commit', ref: 'abc' } }], { parent: { sessionId: 'C', taskId: 't1' } }) },
      ],
      live: [live('G'), live('C'), live('P')],
    }))
    const [p] = rows
    expect(p).toMatchObject({ complete: true, done: 1, total: 1 })
    expect(p.children[0]).toMatchObject({ complete: true })
    expect(p.children[0].children[0]).toMatchObject({ complete: true })
  })

  it('never counts a parent cycle as complete', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'A', pool: pool('A', [{ children: ['B'], status: 'done' }]) },
        { id: 'B', pool: pool('B', [{ children: ['A'], status: 'done' }]) },
      ],
      live: [live('A'), live('B')],
    }))
    for (const { row } of flatten(rows)) expect(row.complete, row.sessionId).toBe(false)
  })

  it('lists ended sessions after live ones even when their names sort first', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'a', pool: pool('a', [{}], { title: 'aaa' }) },
        { id: 'z', pool: pool('z', [{}], { title: 'zzz' }) },
        { id: 'm', pool: pool('m', [{}], { title: 'mmm' }) },
      ],
      live: [live('z'), live('m')],
    }))
    expect(rows.map(r => r.name)).toEqual(['mmm', 'zzz', 'aaa'])
  })

  it('sorts children by name', () => {
    const child = (id: string, title: string) => ({ id, pool: pool(id, [{}], { title, parent: { sessionId: 'P', taskId: 't1' } }) })
    const rows = buildOverview(input({
      pools: [{ id: 'P', pool: pool('P', [{ children: ['Z', 'A', 'M'] }]) }, child('Z', 'zeta'), child('A', 'alpha'), child('M', 'mid')],
      live: [live('P'), live('Z'), live('A'), live('M')],
    }))
    expect(rows[0].children.map(c => c.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('carries the herdr pane of a session, and none for an external one', () => {
    const rows = buildOverview(input({
      live: [live('H'), live('E')],
      agents: [agent('H', 'in-herdr')],
    }))
    expect(rows.find(r => r.sessionId === 'H')).toMatchObject({ paneId: 'p-in-herdr', tag: 'herdr' })
    expect(rows.find(r => r.sessionId === 'E')!.paneId).toBeUndefined()
  })

  it('does not call a child an orphan while its parent is live without a pool, or ended with one', () => {
    const child = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    const rows = buildOverview(input({
      // D was last written two days ago, so only its live child K2 brings it onto the screen
      pools: [child('K1', 'L'), child('K2', 'D'), { id: 'D', pool: pool('D', [{ children: ['K2'] }], { updatedAt: NOW - 2 * DAY }) }],
      live: [live('L'), live('K1'), live('K2')],
    }))
    const all = flatten(rows).map(l => l.row)
    expect(rows.find(r => r.sessionId === 'D')).toMatchObject({ state: 'ended', children: [{ sessionId: 'K2' }] })
    expect(all.find(r => r.sessionId === 'K1')!.orphan).toBe(false)
    expect(all.find(r => r.sessionId === 'K2')!.orphan).toBe(false)
    expect(all.find(r => r.sessionId === 'L')).toMatchObject({ orphan: false, hasPool: false })
    expect(all.find(r => r.sessionId === 'K1')).toMatchObject({ hasPool: true })
  })

  it('reports hasPool only for a pool that has tasks', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'E', pool: pool('E', []) }, { id: 'F', pool: pool('F', [{}]) }, { id: 'U', error: 'bad' }],
      live: [live('E'), live('F'), live('U'), live('N')],
    }))
    const has = Object.fromEntries(rows.map(r => [r.sessionId, r.hasPool]))
    expect(has).toEqual({ E: false, F: true, U: false, N: false })
    expect(rows.find(r => r.sessionId === 'F')).toMatchObject({ orphan: false, total: 1, done: 0, complete: false })
  })
})
