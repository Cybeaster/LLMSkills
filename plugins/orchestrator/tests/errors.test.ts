import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'

describe('OrchError', () => {
  it('carries a message and defaults to exit code 1', () => {
    const e = new OrchError('nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('nope')
    expect(e.code).toBe(1)
    expect(e.name).toBe('OrchError')
    expect(new OrchError('usage', 2).code).toBe(2)
  })
})
