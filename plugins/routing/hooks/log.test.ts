import { expect, test } from 'claude-code/testing'
import { logPath, makeLogger } from './log.ts'

test('one file per session per day', async () => {
  expect(logPath('/h', new Date('2026-10-22T10:00:00Z'), 'ab12')).toBe('/h/.claude/state/routing/2026-10-22-ab12.jsonl')
})

test('rows append in order, one JSON line each', async () => {
  const files = new Map<string, string>()
  const fs = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p) ?? '',
    write: async (p: string, t: string) => void files.set(p, t),
  }
  const log = makeLogger(fs, async () => '/x.jsonl')
  await Promise.all([log({ n: 1 }), log({ n: 2 })])
  await log({ n: 3 })
  expect(files.get('/x.jsonl')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
})

test('a failing write never throws to the caller', async () => {
  const fs = { exists: async () => false, read: async () => '', write: async () => { throw new Error('EACCES') } }
  await makeLogger(fs, async () => '/x')({ n: 1 })
})
