import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, type Row } from '../src/overview.js'
import { App, type Actions } from '../src/tui/App.js'
import { tuiActions } from '../src/tui/main.js'
import { update } from '../src/store.js'
import { makeCtx, writeSession } from './helpers.js'

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

const keys = { esc: '\x1b', left: '\x1b[D', down: '\x1b[B', up: '\x1b[A' }
const press = async (app: { stdin: { write: (s: string) => void } }, ...ks: string[]) => {
  for (const k of ks) {
    app.stdin.write(k)
    await new Promise(r => setTimeout(r, k === keys.esc ? 80 : 30))
  }
}
const last = (app: { lastFrame: () => string | undefined }) => app.lastFrame()!

// P (with its child C) and O, plus any extra sessions that each wait on a question
function world(extra: string[] = [], without: string[] = []): Row[] {
  const ids = ['P', 'C', 'O', ...extra].filter(i => !without.includes(i))
  return buildOverview({
    pools: [
      { id: 'P', pool: pool('P', 'Courses', [{ status: 'done', evidence: { kind: 'commit', ref: '9f3e2a1' } }, { children: ['C'], status: 'in_progress' }]) },
      { id: 'C', pool: pool('C', 'Python', [{ needsInput: 'Strict?' }], { parent: { sessionId: 'P', taskId: 't2' } }) },
      { id: 'O', pool: pool('O', 'Orchestrator', [{}]) },
      ...extra.map(id => ({ id, pool: pool(id, `Extra ${id}`, [{ needsInput: 'Now?' }]) })),
    ].filter(e => ids.includes(e.id)),
    live: ids.map(id => ({ pid: 1, sessionId: id, cwd: `/src/${id}`, status: 'idle' as const })),
    agents: [
      { sessionId: 'P', name: 'beginner-courses', paneId: 'pP', status: 'idle' },
      { sessionId: 'C', name: 'course-python', paneId: 'pC', status: 'idle' },
      ...extra.map(id => ({ sessionId: id, name: `extra-${id}`, paneId: `p${id}`, status: 'idle' as const })),
    ],
    checks: new Map(),
    now: 1000,
  })
}

function mount(data: Row[], over: Partial<Actions> = {}, props: Partial<Parameters<typeof App>[0]> = {}) {
  const actions: Actions = {
    load: vi.fn(async () => data),
    focus: vi.fn(async (r: Row) => `focused ${r.name}`),
    link: vi.fn(async (c: Row, p: Row, t: string) => `${c.name} under ${p.name} ${t}`),
    ...over,
  }
  const app = render(<App initial={data} actions={actions} interval={0} {...props} />)
  return { app, actions }
}

describe('selection', () => {
  it('stays on the same session when a reload puts a flagged row above it', async () => {
    let data = world()
    const { app } = mount(data, { load: vi.fn(async () => data) })
    await press(app, 'j', 'j')
    expect(last(app)).toMatch(/▸ Orchestrator/)
    data = world(['N'])
    await press(app, 'r')
    expect(last(app)).toMatch(/▸ Orchestrator/)
    expect(last(app)).toContain('extra-N')
  })

  it('clamps to a valid row when the selected session disappears', async () => {
    let data = world()
    const { app } = mount(data, { load: vi.fn(async () => data) })
    await press(app, 'j', 'j')
    data = world([], ['O'])
    await press(app, 'r')
    expect(last(app)).toMatch(/▸ └ course-python/)
  })

  it('keeps the highlight on the same parent candidate in the picker across a reload', async () => {
    let data = world()
    const { app } = mount(data, { load: vi.fn(async () => data) })
    await press(app, 'j', 'j', 'l', 'j')
    expect(last(app)).toMatch(/▸ course-python/)
    data = world(['N'])
    await press(app, 'r')
    expect(last(app)).toMatch(/▸ course-python/)
  })
})

describe('the l picker', () => {
  it('does not offer a descendant, the session itself or a session without a pool', async () => {
    const data = world(['X'])
    const noPool = buildOverview({
      pools: [],
      live: [{ pid: 1, sessionId: 'Z', cwd: '/src/Z', status: 'idle' }],
      agents: [{ sessionId: 'Z', name: 'no-pool-z', paneId: 'pZ', status: 'idle' }],
      checks: new Map(),
      now: 1000,
    })
    const { app } = mount([...data, ...noPool])
    await press(app, 'l')
    const frame = last(app)
    expect(frame).toContain('Attach beginner-courses under which session?')
    expect(frame).not.toContain('course-python')
    expect(frame).not.toContain('no-pool-z')
    expect(frame.split('\n').filter(l => l.includes('beginner-courses')).length).toBe(1)
    expect(frame).toContain('Orchestrator')
    expect(frame).toContain('extra-X')
  })

  it('says so when there is nothing to attach under', async () => {
    const only = world([], ['C', 'O'])
    const { app } = mount(only)
    await press(app, 'l')
    expect(last(app)).toContain('no session with a pool to attach under')
  })

  it('links the parent that was picked, not the first one', async () => {
    const { app, actions } = mount(world())
    await press(app, 'j', 'j', 'l', 'j', '\r')
    expect(last(app)).toContain('Which task of course-python?')
    await press(app, '\r')
    expect(actions.link).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'O' }), expect.objectContaining({ sessionId: 'C' }), 't1')
  })

  it('reloads after a link', async () => {
    const { app, actions } = mount(world())
    await press(app, 'j', 'j', 'l', '\r', 'j', '\r')
    expect(actions.link).toHaveBeenCalled()
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('shows a failed link without an error class prefix', async () => {
    const link = vi.fn(async () => {
      throw new Error('that parent sits below this session')
    })
    const { app } = mount(world(), { link })
    await press(app, 'j', 'j', 'l', '\r', '\r')
    expect(last(app)).toContain('that parent sits below this session')
    expect(last(app)).not.toContain('Error:')
  })
})

describe('messages', () => {
  it('shows a failed refresh without the error class prefix', async () => {
    const { app } = mount(world(), { load: vi.fn(async () => Promise.reject(new Error('herdr is down'))) })
    await press(app, 'r')
    expect(last(app)).toContain('refresh failed: herdr is down')
    expect(last(app)).not.toContain('Error:')
  })

  it('strips terminal escapes from a message', async () => {
    const { app } = mount(world(), { load: vi.fn(async () => Promise.reject('x\x1b]0;PWNED\x07y')) })
    await press(app, 'r')
    expect(last(app)).toContain('refresh failed: xy')
    expect(last(app)).not.toContain('PWNED')
    expect(last(app)).not.toMatch(/\x1b\]/)
  })

  it('shows a failed focus', async () => {
    const { app } = mount(world(), { focus: vi.fn(async () => Promise.reject(new Error('no such pane'))) })
    await press(app, 'f')
    expect(last(app)).toContain('no such pane')
    expect(last(app)).not.toContain('Error:')
  })

  it('shows the claude.ai link with o when there is one', async () => {
    const data = world()
    data[0] = { ...data[0], link: 'https://claude.ai/code/session_abc' }
    const { app } = mount(data)
    await press(app, 'o')
    expect(last(app)).toContain('https://claude.ai/code/session_abc')
  })
})

describe('loading', () => {
  it('paints at once with a loading line, then shows the first data', async () => {
    let finish: (r: Row[]) => void = () => {}
    const load = vi.fn(() => new Promise<Row[]>(r => (finish = r)))
    const app = render(<App actions={{ load, focus: vi.fn(), link: vi.fn() }} interval={0} />)
    expect(last(app)).toContain('loading…')
    expect(last(app)).not.toContain('no sessions')
    expect(load).toHaveBeenCalledTimes(1)
    finish(world())
    await press(app)
    await new Promise(r => setTimeout(r, 30))
    expect(last(app)).toContain('beginner-courses')
    expect(last(app)).not.toContain('loading…')
  })

  it('says no sessions when there are none', () => {
    expect(last(mount([]).app)).toContain('no sessions')
  })

  it('stops loading after a failed first load', async () => {
    const app = render(<App actions={{ load: async () => Promise.reject(new Error('boom')), focus: vi.fn(), link: vi.fn() }} interval={0} />)
    await press(app)
    await new Promise(r => setTimeout(r, 30))
    expect(last(app)).not.toContain('loading…')
    expect(last(app)).toContain('refresh failed: boom')
  })
})

describe('quitting', () => {
  it('q quits with 0 and ctrl-c with 130', async () => {
    const q = vi.fn()
    await press(mount(world(), {}, { onQuit: q }).app, 'q')
    expect(q).toHaveBeenCalledWith(0)
    const c = vi.fn()
    await press(mount(world(), {}, { onQuit: c }).app, '\x03')
    expect(c).toHaveBeenCalledWith(130)
  })

  it('stops refreshing once unmounted', async () => {
    const { app, actions } = mount(world(), {}, { interval: 20 })
    await new Promise(r => setTimeout(r, 70))
    app.unmount()
    const n = (actions.load as ReturnType<typeof vi.fn>).mock.calls.length
    expect(n).toBeGreaterThan(0)
    await new Promise(r => setTimeout(r, 100))
    expect((actions.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n)
  })
})

describe('navigation', () => {
  it('k stops at the first row, r reloads', async () => {
    const { app, actions } = mount(world())
    await press(app, 'k', 'k', 'f')
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'beginner-courses' }))
    await press(app, 'r')
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('arrow keys move too', async () => {
    const { app, actions } = mount(world())
    await press(app, keys.down, keys.down, keys.up, 'f')
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'course-python' }))
  })

  it('shows the pool of the selected row, and f works there', async () => {
    const { app, actions } = mount(world())
    await press(app, 'j', '\r')
    expect(last(app)).toMatch(/course-python — Python/)
    expect(last(app)).not.toMatch(/beginner-courses — Courses/)
    await press(app, 'f')
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'course-python' }))
    expect(last(app)).toContain('focused course-python')
  })

  it.each([
    ['esc', keys.esc],
    ['left arrow', keys.left],
    ['h', 'h'],
  ])('%s goes back from a pool', async (_n, key) => {
    const { app } = mount(world())
    await press(app, 'j', '\r')
    await press(app, key)
    expect(last(app)).toMatch(/▸ └ course-python/)
    expect(last(app)).toContain('ORCHESTRATOR')
  })

  it('cancels a picker with esc', async () => {
    const { app } = mount(world())
    await press(app, 'l', keys.esc)
    expect(last(app)).not.toContain('which session')
    expect(last(app)).toContain('ORCHESTRATOR')
  })
})

describe('filter', () => {
  it('types, backspaces, and clears with esc', async () => {
    const { app } = mount(world())
    await press(app, '/', 'o', 'r', 'x')
    expect(last(app)).toContain('filter: orx')
    expect(last(app)).toContain('no sessions')
    await press(app, '\x7f')
    expect(last(app)).toContain('filter: or')
    expect(last(app)).toMatch(/Orchestrator/)
    await press(app, keys.esc)
    expect(last(app)).not.toContain('filter:')
    expect(last(app)).toContain('beginner-courses')
    await press(app, 'j')
    await press(app, 'f')
  })

  it('esc after enter clears an applied filter', async () => {
    const { app } = mount(world())
    await press(app, '/', 'o', 'r', '\r')
    expect(last(app)).toContain('filter: or')
    await press(app, keys.esc)
    expect(last(app)).not.toContain('filter:')
  })

  it('keeps the ancestors of a matching child', async () => {
    const { app } = mount(world())
    await press(app, '/', 'p', 'y', 't', 'h', 'o', 'n', '\r')
    expect(last(app)).toMatch(/beginner-courses/)
    expect(last(app)).toMatch(/└ course-python/)
    expect(last(app)).not.toContain('Orchestrator')
  })

  it('matches the cwd and the title', async () => {
    const { app } = mount(world())
    await press(app, '/', ...'/src/o', '\r')
    expect(last(app)).toMatch(/Orchestrator/)
    expect(last(app)).not.toContain('beginner-courses')
    await press(app, keys.esc, '/', ...'extra p', '\r')
    expect(last(app)).toContain('no sessions')
    const data = world(['T'])
    data[data.findIndex(r => r.sessionId === 'T')] = { ...data.find(r => r.sessionId === 'T')!, name: 'plain', title: 'Zebra crossing' }
    const second = mount(data)
    await press(second.app, '/', ...'zebra', '\r')
    expect(last(second.app)).toContain('plain')
    expect(last(second.app)).not.toContain('Orchestrator')
  })

  it('puts the cursor back on the first row when the filter changes', async () => {
    const { app, actions } = mount(world())
    await press(app, 'j', 'j', '/', 'c', 'o', 'u', '\r', 'f')
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'beginner-courses' }))
  })
})

describe('modified keys and the highlight after a link', () => {
  it('keeps ctrl- and meta-modified characters out of the filter', async () => {
    const { app } = mount(world())
    await press(app, '/', '\x01', '\x1bx', 'z')
    expect(last(app)).toContain('filter: z')
    expect(last(app)).not.toMatch(/filter: [^z\n]*[ax]/)
  })

  it('selects the child again after linking it from the picker', async () => {
    const { app, actions } = mount(world())
    await press(app, 'j', 'j', 'l', '\r', 'j', '\r')
    expect(actions.link).toHaveBeenCalled()
    expect(last(app)).toMatch(/▸ Orchestrator/)
  })
})

describe('small terminals', () => {
  it('scrolls the pool view one line per j and stops at the ends', async () => {
    const long = buildOverview({
      pools: [{ id: 'B', pool: pool('B', 'Many', Array.from({ length: 30 }, () => ({}))) }],
      live: [{ pid: 1, sessionId: 'B', cwd: '/src/B', status: 'idle' }],
      agents: [],
      checks: new Map(),
      now: 1000,
    })
    const { app } = mount(long, {}, { rows: 10 })
    await press(app, '\r')
    expect(last(app)).toMatch(/· t1 /)
    await press(app, 'k')
    expect(last(app)).toMatch(/· t1 /)
    await press(app, 'j')
    expect(last(app)).not.toMatch(/· t1 /)
    expect(last(app)).toMatch(/· t2 /)
    await press(app, 'k')
    expect(last(app)).toMatch(/· t1 /)
    for (let i = 0; i < 60; i++) await press(app, 'j')
    expect(last(app)).toMatch(/· t30 /)
    expect(last(app)).not.toMatch(/· t1 /)
  }, 30000)

  it.each([8, 10, 12])('no screen reaches %i lines, in the list, a picker or a pool', async rows => {
    const ids = Array.from({ length: 14 }, (_, i) => `E${i + 1}`)
    const data = world(ids)
    const { app } = mount(data, { focus: vi.fn(async () => 'a message') }, { rows })
    const check = () => expect(last(app).split('\n').length).toBeLessThan(rows)
    check()
    await press(app, 'f')
    check()
    for (let i = 0; i < 16; i++) await press(app, 'j')
    check()
    await press(app, 'l')
    check()
    for (let i = 0; i < 16; i++) await press(app, 'j')
    check()
    await press(app, keys.esc)
    await press(app, '\r')
    check()
    const long = buildOverview({
      pools: [{ id: 'B', pool: pool('B', 'Many', Array.from({ length: 30 }, () => ({}))) }],
      live: [{ pid: 1, sessionId: 'B', cwd: '/src/B', status: 'idle' }],
      agents: [],
      checks: new Map(),
      now: 1000,
    })
    const second = mount(long, { focus: vi.fn(async () => 'a message') }, { rows })
    await press(second.app, '\r', 'f')
    expect(last(second.app).split('\n').length).toBeLessThan(rows)
    for (let i = 0; i < 40; i++) await press(second.app, 'j')
    expect(last(second.app).split('\n').length).toBeLessThan(rows)
    expect(last(second.app)).toContain('Many step 30')
  }, 30000)


  const many = () => world(Array.from({ length: 8 }, (_, i) => `E${i + 1}`))

  it('shows a window of rows that fits and scrolls with the cursor', async () => {
    const { app } = mount(many(), {}, { rows: 8 })
    const lines = (last(app).match(/extra-E\d/g) ?? []).length
    expect(lines).toBeGreaterThan(0)
    expect(last(app).split('\n').length).toBeLessThanOrEqual(8)
    expect(last(app)).not.toContain('extra-E8')
    for (let i = 0; i < 12; i++) await press(app, 'j')
    expect(last(app).split('\n').length).toBeLessThanOrEqual(8)
    expect(last(app)).toContain('extra-E8')
    expect(last(app)).not.toContain('beginner-courses')
    for (let i = 0; i < 12; i++) await press(app, 'k')
    expect(last(app)).toContain('beginner-courses')
  })

  it('cuts a long pool line instead of wrapping it', async () => {
    const data = buildOverview({
      pools: [{ id: 'B', pool: pool('B', 'Blocked', [{ status: 'blocked', blockedReason: 'because '.repeat(60) }]) }],
      live: [{ pid: 1, sessionId: 'B', cwd: '/src/B', status: 'idle' }],
      agents: [],
      checks: new Map(),
      now: 1000,
    })
    const { app } = mount(data)
    await press(app, '\r')
    const body = last(app).split('\n')
    expect(body.every(l => l.length <= 100)).toBe(true)
    expect(body.some(l => l.includes('…'))).toBe(true)
  })
})

describe('tuiActions', () => {
  const row = (o: Partial<Row>): Row => ({ ...world()[0], paneId: undefined, pid: undefined, ...o })

  it('says so when the session is not in herdr', async () => {
    const ctx = makeCtx()
    const a = tuiActions(ctx)
    expect(await a.focus(row({ cwd: '/src/x', pid: 77 }))).toBe('not in herdr: /src/x (pid 77)')
    expect(await a.focus(row({ cwd: '/src/x' }))).toBe('not in herdr: /src/x')
    expect(ctx.herdr.calls).toEqual([])
  })

  it('focuses the herdr pane', async () => {
    const ctx = makeCtx()
    expect(await tuiActions(ctx).focus(row({ paneId: 'w1:p2', name: 'abc' }))).toBe('focused abc')
    expect(ctx.herdr.calls).toEqual([['focus', 'w1:p2']])
  })

  it('refreshes in stale mode, so a slow gh cannot hold it up', async () => {
    const modes: unknown[] = []
    const ctx = makeCtx({
      gh: {
        check: async (_ev, _cwd, opts) => {
          modes.push(opts?.stale)
          return opts?.stale ? 'unknown' : new Promise<never>(() => {})
        },
      },
    })
    writeSession(ctx, { pid: 1, sessionId: 's1', cwd: ctx.cwd })
    await update(ctx.orchHome, 's1', p => ({ ...newPool('s1', ctx.cwd, 0), tasks: [{ id: 't1', text: 'x', status: 'done', evidence: { kind: 'ci', ref: '7' } }], ...(p ? {} : {}) }))
    const rows = await tuiActions(ctx).load()
    expect(rows).toHaveLength(1)
    expect(modes).toEqual([true])
  })
})
