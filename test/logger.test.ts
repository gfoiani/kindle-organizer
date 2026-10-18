import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { installFileLog } from '../src/main/logger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-logs-'))
  // The suite must stay quiet: these spies are what the file log wraps.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('installFileLog', () => {
  test('copies errors and warnings into main.log, with the stack trace', () => {
    // Arrange
    const restore = installFileLog(dir)

    // Act
    try {
      console.error('[convert] failed:', new Error('boom'))
      console.warn('careful')
    } finally {
      restore()
    }

    // Assert
    const text = readFileSync(path.join(dir, 'main.log'), 'utf-8')
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR \[convert\] failed: Error: boom/m)
    expect(text).toContain('logger.test.ts')
    expect(text).toMatch(/WARN careful/)
  })

  test('still prints to the console it wraps', () => {
    const original = vi.mocked(console.error)
    const restore = installFileLog(dir)

    console.error('visible')
    restore()

    expect(original).toHaveBeenCalledWith('visible')
  })

  test('rotates past the size limit, keeping one previous file', () => {
    const restore = installFileLog(dir, { maxBytes: 300 })

    for (let i = 0; i < 20; i++) console.error(`line ${i} ${'x'.repeat(40)}`)
    restore()

    expect(existsSync(path.join(dir, 'main.old.log'))).toBe(true)
    expect(statSync(path.join(dir, 'main.log')).size).toBeLessThanOrEqual(400)
    expect(readFileSync(path.join(dir, 'main.log'), 'utf-8')).toContain('line 19')
  })

  test('puts the console back when restored', () => {
    const original = console.error
    const restore = installFileLog(dir)

    restore()

    expect(console.error).toBe(original)
  })
})
