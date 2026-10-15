import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, type Row } from '../src/overview.js'
import { App, type Actions } from '../src/tui/App.js'

const tick = () => new Promise(r => setTimeout(r, 30))

function pool(id: string, title: string, tasks: Partial<Task>[], extra: Partial<Pool> = {}): Pool {
  return { ...newPool(id, `/src/${id}`, 0), title, tasks: tasks.map((t, i) => ({ id: `t${i + 1}`, text: `${title} step ${i + 1}`, status: 'pending', ...t })), ...extra }
}

function rows(): Row[] {
  return buildOverview({
    pools: [
      { id: 'P', pool: pool('P', 'Courses', [{ status: 'done', evidence: { kind: 'commit', ref: '9f3e2a1' } }, { children: ['C'], status: 'in_progress' }]) },
      { id: 'C', pool: pool('C', 'Python', [{ needsInput: 'Strict?' }], { parent: { sessionId: 'P', taskId: 't2' } }) },
      { id: 'O', pool: pool('O', 'Orchestrator', [{}]) },
    ],
    live: ['P', 'C', 'O'].map(id => ({ pid: 1, sessionId: id, cwd: `/src/${id}`, status: 'idle' as const })),
    agents: [
      { sessionId: 'P', name: 'beginner-courses', paneId: 'pP', status: 'idle' },
      { sessionId: 'C', name: 'course-python', paneId: 'pC', status: 'idle' },
    ],
    checks: new Map(),
    now: 1000,
  })
}

function setup() {
  const data = rows()
  const actions: Actions = {
    load: vi.fn(async () => data),
    focus: vi.fn(async (r: Row) => `focused ${r.name}`),
    link: vi.fn(async (c: Row, p: Row, t: string) => `${c.name} under ${p.name} ${t}`),
  }
  const app = render(<App initial={data} actions={actions} interval={0} />)
  return { app, actions }
}

describe('TUI', () => {
  it('runs one refresh at a time', async () => {
    let finish: (r: Row[]) => void = () => {}
    const load = vi.fn(() => new Promise<Row[]>(r => (finish = r)))
    const app = render(<App initial={rows()} actions={{ load, focus: vi.fn(), link: vi.fn() }} interval={20} />)
    await new Promise(r => setTimeout(r, 120))
    expect(load).toHaveBeenCalledTimes(1)
    finish(rows())
    await new Promise(r => setTimeout(r, 60))
    expect(load.mock.calls.length).toBeGreaterThan(1)
    app.unmount()
  })

  it('lists sessions as a tree with the header', () => {
    const frame = setup().app.lastFrame()!
    expect(frame).toContain('ORCHESTRATOR  3 live · 1 ⚑ · 0 ended')
    expect(frame).toMatch(/▸ beginner-courses .* 1\/2  ⚑1/)
    expect(frame).toMatch(/└ course-python/)
    expect(frame).toMatch(/Orchestrator .*external/)
  })

  it('opens a pool with enter and goes back with h', async () => {
    const { app } = setup()
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toMatch(/beginner-courses — Courses/)
    expect(app.lastFrame()).toMatch(/✓ t1\s+Courses step 1\s+commit 9f3e2a1/)
    expect(app.lastFrame()).toMatch(/◐ t2 .*1 children: 0 ✓ 1 running/)
    app.stdin.write('h')
    await tick()
    expect(app.lastFrame()).toContain('ORCHESTRATOR')
    expect(app.lastFrame()).toMatch(/▸ beginner-courses/)
  })

  it('moves with j and focuses with f', async () => {
    const { app, actions } = setup()
    app.stdin.write('j')
    await tick()
    app.stdin.write('f')
    await tick()
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'course-python' }))
    expect(app.lastFrame()).toContain('focused course-python')
  })

  it('attaches a session under a parent task with l', async () => {
    const { app, actions } = setup()
    app.stdin.write('j')
    await tick()
    app.stdin.write('j')
    await tick()
    app.stdin.write('l')
    await tick()
    expect(app.lastFrame()).toContain('Attach Orchestrator under which session?')
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toContain('Which task of beginner-courses?')
    app.stdin.write('j')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(actions.link).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'O' }), expect.objectContaining({ sessionId: 'P' }), 't2')
    expect(app.lastFrame()).toContain('Orchestrator under beginner-courses t2')
  })

  it('filters with /', async () => {
    const { app } = setup()
    app.stdin.write('/')
    await tick()
    for (const ch of 'orch') {
      app.stdin.write(ch)
      await tick()
    }
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toContain('filter: orch')
    expect(app.lastFrame()).not.toContain('course-python')
    expect(app.lastFrame()).toMatch(/▸ Orchestrator/)
  })

  it('shows the claude.ai link with o', async () => {
    const { app } = setup()
    app.stdin.write('o')
    await tick()
    expect(app.lastFrame()).toContain('not on Remote Control')
  })
})
