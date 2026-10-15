import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeCtx } from './helpers.js'

describe('makeCtx', () => {
  let home = ''

  it('makes a home that exists while the test runs', () => {
    home = makeCtx().cwd
    expect(existsSync(home)).toBe(true)
  })

  it('has removed the home of the test before it', () => {
    expect(home).not.toBe('')
    expect(existsSync(home)).toBe(false)
  })
})
