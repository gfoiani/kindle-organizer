import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { writeFileAtomically } from '../src/main/atomicWrite'

describe('writeFileAtomically', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'atomic-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('writes the content and leaves only the target', async () => {
    await writeFileAtomically(path.join(dir, 'a.txt'), 'hello')

    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hello')
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })

  test('when the rename fails, the error surfaces and the temp file is removed', async () => {
    // Arrange: a non-empty folder where the file should go makes the rename fail.
    const target = path.join(dir, 'busy')
    mkdirSync(path.join(target, 'child'), { recursive: true })

    // Act + Assert
    await expect(writeFileAtomically(target, 'data')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['busy'])
  })
})
