import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import {
  addTask, askTask, blockTask, clearQuestions, doneTask, linkChild, newPool, plan,
  setParent, setTitle, startTask, startTurn, unlinkChild,
} from '../src/model.js'
import type { Pool } from '../src/model.js'

const base = () => newPool('s1', '/repo', 100)

describe('plan', () => {
  it('numbers tasks from t1', () => {
    const p = plan(base(), ['a', 'b'], 200)
    expect(p.tasks.map(t => [t.id, t.text, t.status])).toEqual([['t1', 'a', 'pending'], ['t2', 'b', 'pending']])
    expect(p.touchedAt).toBe(200)
  })

  it('keeps started, done, blocked and asking tasks and never reuses ids', () => {
    let p = plan(base(), ['a', 'b', 'c', 'd'], 200)
    p = doneTask(p, 't1', { kind: 'commit', ref: 'abc1234' }, 210)
    p = blockTask(p, 't3', 'x', 215)
    p = startTask(p, 't2', 220)
    p = askTask(p, 't4', 'which?', 230)
    p = plan(p, ['x'], 240)
    expect(p.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(p.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('takes the next id from the highest existing one when seq is missing', () => {
    const p = plan(base(), ['a', 'b'], 200)
    delete (p as Partial<Pool>).seq
    expect(addTask(p, 'c', 210).tasks.map(t => t.id)).toEqual(['t1', 't2', 't3'])
    expect(plan(p, ['x', 'y'], 210).tasks.map(t => t.id)).toEqual(['t3', 't4'])
  })

  it('does not mutate its input', () => {
    const p = base()
    plan(p, ['a'], 200)
    expect(p.tasks).toEqual([])
  })
})

describe('task edits', () => {
  it('adds, starts, blocks and finishes', () => {
    let p = addTask(base(), 'a', 200)
    p = blockTask(p, 't1', 'waiting on CI', 210)
    expect(p.tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'waiting on CI' })
    p = startTask(p, 't1', 220)
    expect(p.tasks[0].blockedReason).toBeUndefined()
    p = doneTask(p, 't1', undefined, 230)
    expect(p.tasks[0]).toMatchObject({ status: 'done' })
    expect(p.tasks[0].evidence).toBeUndefined()
  })

  it('drops old evidence when ticked again without any', () => {
    let p = addTask(base(), 'a', 200)
    p = doneTask(p, 't1', { kind: 'pr', ref: '41' }, 210)
    p = doneTask(p, 't1', undefined, 220)
    expect(p.tasks[0].evidence).toBeUndefined()
  })

  it('clears a pending question when the task is finished', () => {
    let p = askTask(addTask(base(), 'a', 200), 't1', 'which?', 210)
    p = doneTask(p, 't1', undefined, 220)
    expect(p.tasks[0].needsInput).toBeUndefined()
  })

  it('drops evidence when a done task is started or blocked again', () => {
    const done = doneTask(addTask(base(), 'a', 200), 't1', { kind: 'commit', ref: 'abc1234' }, 210)
    expect(startTask(done, 't1', 220).tasks[0].evidence).toBeUndefined()
    expect(blockTask(done, 't1', 'x', 220).tasks[0].evidence).toBeUndefined()
  })

  it('throws OrchError for an unknown id', () => {
    expect(() => startTask(base(), 't9', 200)).toThrow(OrchError)
  })

  it('sets the title as an own write', () => {
    expect(setTitle(base(), 'Courses', 200)).toMatchObject({ title: 'Courses', touchedAt: 200 })
  })
})

describe('questions', () => {
  it('returns undefined when there is nothing to clear', () => {
    expect(clearQuestions(addTask(base(), 'a', 200), 300)).toBeUndefined()
  })

  it('clears one task or all, without counting as an own write', () => {
    let p = plan(base(), ['a', 'b'], 200)
    p = askTask(askTask(p, 't1', 'q1', 210), 't2', 'q2', 211)
    const one = clearQuestions(p, 300, 't1')!
    expect(one.tasks.map(t => t.needsInput)).toEqual([undefined, 'q2'])
    expect(one.touchedAt).toBe(211)
    expect(clearQuestions(p, 300)!.tasks.every(t => !t.needsInput)).toBe(true)
  })
})

describe('links', () => {
  it('links a child once and starts a pending task', () => {
    let p = plan(base(), ['fan out'], 200)
    p = linkChild(linkChild(p, 't1', 'c1', 300), 't1', 'c1', 301)
    expect(p.tasks[0]).toMatchObject({ children: ['c1'], status: 'in_progress' })
    expect(p.touchedAt).toBe(200)
  })

  it('counts a link made by the owner as an own write', () => {
    const p = linkChild(plan(base(), ['fan out'], 200), 't1', 'c1', 300, true)
    expect(p).toMatchObject({ touchedAt: 300, updatedAt: 300 })
    expect(p.tasks[0]).toMatchObject({ children: ['c1'], status: 'in_progress' })
  })

  it('keeps a done task done when a child is linked', () => {
    let p = doneTask(plan(base(), ['a'], 200), 't1', undefined, 210)
    p = linkChild(p, 't1', 'c1', 300, true)
    expect(p.tasks[0]).toMatchObject({ status: 'done', children: ['c1'] })
  })

  it('unlinks a child and drops an empty list', () => {
    let p = linkChild(plan(base(), ['fan out'], 200), 't1', 'c1', 300)
    p = unlinkChild(p, 't1', 'c1', 310)
    expect(p.tasks[0].children).toBeUndefined()
  })

  it('leaves the tasks alone when unlinking from an unknown task', () => {
    const p = plan(base(), ['a'], 200)
    const q = unlinkChild(p, 't9', 'c1', 310)
    expect(q.tasks).toEqual(p.tasks)
    expect(q.updatedAt).toBe(310)
  })

  it('records the parent and the brief', () => {
    const p = setParent(base(), { sessionId: 'p1', taskId: 't2' }, '/repo/brief.md', 300)
    expect(p).toMatchObject({ parent: { sessionId: 'p1', taskId: 't2' }, brief: '/repo/brief.md', updatedAt: 300 })
    expect(p.touchedAt).toBeUndefined()
  })

  it('drops the brief when moved to another parent without a new one', () => {
    const p1 = setParent(base(), { sessionId: 'p1', taskId: 't1' }, '/a.md', 300)
    const moved = setParent(p1, { sessionId: 'p2', taskId: 't1' }, undefined, 310)
    expect(moved.parent).toEqual({ sessionId: 'p2', taskId: 't1' })
    expect(moved.brief).toBeUndefined()
    expect(setParent(p1, { sessionId: 'p2', taskId: 't1' }, '/b.md', 310).brief).toBe('/b.md')
  })

  it('keeps the brief when the same parent is recorded again without one', () => {
    const p1 = setParent(base(), { sessionId: 'p1', taskId: 't1' }, '/a.md', 300)
    expect(setParent(p1, { sessionId: 'p1', taskId: 't3' }, undefined, 310).brief).toBe('/a.md')
  })
})

describe('turns', () => {
  it('marks the start of a turn without counting as an own write', () => {
    const p = startTurn(base(), 400)
    expect(p).toMatchObject({ turnStartedAt: 400, updatedAt: 400 })
    expect(p.touchedAt).toBeUndefined()
    expect(startTurn(plan(base(), ['a'], 200), 400).touchedAt).toBe(200)
  })
})

describe('immutability', () => {
  const rich = (): Pool => {
    let p = plan(base(), ['a', 'b', 'c', 'd'], 200)
    p = doneTask(p, 't1', { kind: 'cmd', ref: 'npm test', exit: 0 }, 210)
    p = linkChild(p, 't2', 'c1', 220)
    p = blockTask(p, 't3', 'waiting', 230)
    p = askTask(p, 't4', 'which?', 240)
    p = setParent(p, { sessionId: 'p1', taskId: 't9' }, '/repo/brief.md', 250)
    return startTurn(setTitle(p, 'Courses', 255), 260)
  }

  it('no mutation changes its input', () => {
    const mutations: [string, (p: Pool) => Pool | undefined][] = [
      ['plan', p => plan(p, ['x'], 300)],
      ['addTask', p => addTask(p, 'x', 300)],
      ['setTitle', p => setTitle(p, 'Other', 300)],
      ['startTask', p => startTask(p, 't3', 300)],
      ['blockTask', p => blockTask(p, 't1', 'x', 300)],
      ['doneTask', p => doneTask(p, 't4', { kind: 'pr', ref: '1' }, 300)],
      ['askTask', p => askTask(p, 't2', 'q', 300)],
      ['clearQuestions', p => clearQuestions(p, 300)],
      ['clearQuestions (one task)', p => clearQuestions(p, 300, 't4')],
      ['setParent', p => setParent(p, { sessionId: 'p2', taskId: 't1' }, undefined, 300)],
      ['linkChild', p => linkChild(p, 't2', 'c2', 300, true)],
      ['unlinkChild', p => unlinkChild(p, 't2', 'c1', 300)],
      ['startTurn', p => startTurn(p, 300)],
    ]
    const pool = rich()
    const before = structuredClone(pool)
    for (const [name, run] of mutations) {
      const out = run(pool)
      expect(out, name).not.toBe(pool)
      expect(pool, name).toEqual(before)
    }
  })
})
