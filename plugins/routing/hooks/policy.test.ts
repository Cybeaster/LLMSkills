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
