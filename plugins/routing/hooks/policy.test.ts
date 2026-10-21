import { expect, test } from 'claude-code/testing'
import { check, merge, rank, ruleText, denyText, MODELS, EFFORTS, type Policy } from './policy.ts'

const P: Policy = {
  classes: {
    search: { model: 'haiku', effort: 'low' },
    content: { model: 'opus', effort: 'xhigh' },
    review: { model: 'fable', effort: 'xhigh' },
  },
  spawn: { model: 'opus', effort: 'xhigh' },
  workflowModel: 'opus',
}

test('rank reads aliases, ids and context suffixes', async () => {
  expect(rank(MODELS, 'haiku')).toBe(0)
  expect(rank(MODELS, 'claude-opus-5-5')).toBe(2)
  expect(rank(MODELS, 'fable[1m]')).toBe(3)
  expect(rank(MODELS, undefined)).toBe(-1)
  expect(rank(EFFORTS, 'xhigh')).toBe(3)
})

test('a call without a tag is denied', async () => {
  const v = check(P, { description: 'find callers', model: 'haiku', effort: 'low' })
  expect(v.ok).toBe(false)
  expect(!v.ok && v.reason).toMatch(/no \[class\] tag/)
})

test('an unknown tag is denied', async () => {
  expect(check(P, { description: '[misc] x', model: 'opus', effort: 'high' }).ok).toBe(false)
})

test('missing model or effort is denied', async () => {
  expect(check(P, { description: '[search] x', effort: 'low' }).ok).toBe(false)
  expect(check(P, { description: '[search] x', model: 'haiku' }).ok).toBe(false)
})

test('below the floor is denied, at or above passes', async () => {
  expect(check(P, { description: '[review] diff', model: 'opus', effort: 'xhigh' }).ok).toBe(false)
  expect(check(P, { description: '[review] diff', model: 'fable', effort: 'high' }).ok).toBe(false)
  expect(check(P, { description: '[review] diff', model: 'fable', effort: 'xhigh' })).toEqual({ ok: true, cls: 'review', override: false })
  expect(check(P, { description: '[search] x', model: 'opus', effort: 'high' }).ok).toBe(true)
})

test('content on sonnet is denied', async () => {
  const v = check(P, { description: '[content] lesson 3', model: 'sonnet', effort: 'xhigh' })
  expect(!v.ok && v.reason).toMatch(/needs model opus/)
})

test('max needs [override]', async () => {
  expect(check(P, { description: '[review] x', model: 'fable', effort: 'max' }).ok).toBe(false)
  expect(check(P, { description: '[review] [override] x', model: 'fable', effort: 'max' }).ok).toBe(true)
})

test('[override] lets a call go below its floor', async () => {
  expect(check(P, { description: '[content] [override] x', model: 'sonnet', effort: 'low' })).toEqual({ ok: true, cls: 'content', override: true })
})

test('fork is exempt', async () => {
  expect(check(P, { description: 'anything', subagent_type: 'fork' })).toEqual({ ok: true, override: false, exempt: true })
})

test('layers override per field', async () => {
  const m = merge(P, { classes: { search: { model: 'opus' } } }, undefined, { spawn: { effort: 'high' } })
  expect(m.classes.search).toEqual({ model: 'opus', effort: 'low' })
  expect(m.classes.review).toEqual(P.classes.review)
  expect(m.spawn).toEqual({ model: 'opus', effort: 'high' })
})

test('the rule text carries every class, the spawn floor and the workflow rule', async () => {
  const t = ruleText(P)
  expect(t).toMatch(/\| `\[search\]` \| haiku \| low \|/)
  expect(t).toMatch(/\| `\[review\]` \| fable \| xhigh \|/)
  expect(t).toMatch(/opus \/ xhigh/)
  expect(t).toMatch(/opts\.model.*opts\.effort/)
  expect(t).toMatch(/\[override\]/)
})

test('the deny text says why and shows the table', async () => {
  const t = denyText(P, 'description has no [class] tag')
  expect(t).toMatch(/^routing: description has no \[class\] tag/)
  expect(t).toMatch(/\| `\[content\]` \| opus \| xhigh \|/)
})

test('prototype keys are not classes', async () => {
  for (const tag of ['constructor', 'toString', 'hasOwnProperty']) {
    const v = check(P, { description: `[${tag}] x`, model: 'haiku', effort: 'low' })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/is not a class/)
  }
})

test('max needs [override] in any case', async () => {
  expect(check(P, { description: '[review] x', model: 'fable', effort: 'MAX' }).ok).toBe(false)
  expect(check(P, { description: '[review] x', model: 'fable', effort: 'Max' }).ok).toBe(false)
  expect(check(P, { description: '[review] [override] x', model: 'fable', effort: 'MAX' }).ok).toBe(true)
})

test('the class tag is read case-insensitively', async () => {
  expect(check(P, { description: '[Search] x', model: 'haiku', effort: 'low' })).toEqual({ ok: true, cls: 'search', override: false })
  expect(check(P, { description: '  [REVIEW] x', model: 'fable', effort: 'xhigh' })).toEqual({ ok: true, cls: 'review', override: false })
})

test('[override] may come before the class tag', async () => {
  expect(check(P, { description: '[override] [content] x', model: 'sonnet', effort: 'low' })).toEqual({ ok: true, cls: 'content', override: true })
  expect(check(P, { description: '[override][search] x', model: 'haiku', effort: 'low' })).toEqual({ ok: true, cls: 'search', override: true })
})

test('the class tag must still open the description', async () => {
  const bare = check(P, { description: '[override] x', model: 'haiku', effort: 'low' })
  expect(!bare.ok && bare.reason).toMatch(/no \[class\] tag/)
  expect(check(P, { description: 'find [search] x', model: 'haiku', effort: 'low' }).ok).toBe(false)
  expect(check(P, { description: '[override] find [search] x', model: 'haiku', effort: 'low' }).ok).toBe(false)
})

test('a layer with a bad model or effort cannot weaken or blank a floor', async () => {
  const bad = { model: null, effort: 'turbo', what: 'x' } as unknown as Record<string, string>
  const m = merge(
    P,
    {
      classes: {
        triage: { effort: 'low' },
        junk: { model: 'gpt-5', effort: 'low' },
        search: { model: 'gpt-5' },
        review: bad,
        content: { model: 7 as unknown as string, effort: 'high' },
      },
      spawn: { model: null as unknown as string, effort: 'nope' },
      workflowModel: 'gpt-5',
    },
    { workflowModel: null as unknown as string },
  )
  expect(Object.hasOwn(m.classes, 'triage')).toBe(false)
  expect(Object.hasOwn(m.classes, 'junk')).toBe(false)
  expect(m.classes.search).toEqual({ model: 'haiku', effort: 'low' })
  expect(m.classes.review).toEqual({ model: 'fable', effort: 'xhigh', what: 'x' })
  expect(m.classes.content).toEqual({ model: 'opus', effort: 'high' })
  expect(m.spawn).toEqual({ model: 'opus', effort: 'xhigh' })
  expect(m.workflowModel).toBe('opus')
  const triage = check(m, { description: '[triage] x', model: 'opus', effort: 'high' })
  expect(!triage.ok && triage.reason).toMatch(/\[triage\] is not a class/)
  for (const t of [ruleText(m), denyText(m, 'r')]) {
    expect(t).not.toMatch(/undefined|null/)
  }
})

test('a valid new class and valid layer values still apply', async () => {
  const m = merge(P, { classes: { triage: { model: 'sonnet', effort: 'medium' } }, spawn: { model: 'fable' }, workflowModel: 'sonnet' })
  expect(m.classes.triage).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(m.spawn).toEqual({ model: 'fable', effort: 'xhigh' })
  expect(m.workflowModel).toBe('sonnet')
})
