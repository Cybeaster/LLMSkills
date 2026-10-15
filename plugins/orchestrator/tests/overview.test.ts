import { describe, expect, it } from 'vitest'
import { checkKey, type Check } from '../src/evidence.js'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, DAY, type OverviewInput } from '../src/overview.js'
import type { HerdrAgent } from '../src/sources/herdr.js'
import type { LiveSession } from '../src/sources/sessions.js'

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
})
