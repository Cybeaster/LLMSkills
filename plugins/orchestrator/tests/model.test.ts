import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import {
  addTask, askTask, blockTask, clearQuestions, doneTask, linkChild, newPool, plan,
  setParent, setTitle, startTask, unlinkChild,
} from '../src/model.js'

const base = () => newPool('s1', '/repo', 100)

describe('plan', () => {
  it('numbers tasks from t1', () => {
    const p = plan(base(), ['a', 'b'], 200)
    expect(p.tasks.map(t => [t.id, t.text, t.status])).toEqual([['t1', 'a', 'pending'], ['t2', 'b', 'pending']])
    expect(p.touchedAt).toBe(200)
  })

  it('keeps started, done, blocked, parent and asking tasks and never reuses ids', () => {
    let p = plan(base(), ['a', 'b', 'c', 'd'], 200)
    p = doneTask(p, 't1', { kind: 'commit', ref: 'abc1234' }, 210)
    p = startTask(p, 't2', 220)
    p = askTask(p, 't4', 'which?', 230)
    p = plan(p, ['x'], 240)
    expect(p.tasks.map(t => t.id)).toEqual(['t1', 't2', 't4', 't5'])
    expect(p.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
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

  it('unlinks a child and drops an empty list', () => {
    let p = linkChild(plan(base(), ['fan out'], 200), 't1', 'c1', 300)
    p = unlinkChild(p, 't1', 'c1', 310)
    expect(p.tasks[0].children).toBeUndefined()
  })

  it('records the parent and the brief', () => {
    const p = setParent(base(), { sessionId: 'p1', taskId: 't2' }, '/repo/brief.md', 300)
    expect(p).toMatchObject({ parent: { sessionId: 'p1', taskId: 't2' }, brief: '/repo/brief.md', updatedAt: 300 })
    expect(p.touchedAt).toBeUndefined()
  })
})
