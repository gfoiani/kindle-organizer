import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { getSettings, setKindleFormat } from '../src/main/settings'

let userData: string

function settingsPath(): string {
  return path.join(userData, 'settings.json')
}

function writeRawSettings(value: unknown): void {
  writeFileSync(settingsPath(), JSON.stringify(value, null, 2), 'utf-8')
}

// Each test gets an isolated userData dir (fresh settings.json).
beforeEach(() => {
  userData = freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('getSettings — defaults and tolerant reads', () => {
  test('returns the AZW3 default when no settings file exists', () => {
    // Arrange — fresh profile, no settings.json.

    // Act
    const settings = getSettings()

    // Assert
    expect(settings).toEqual({ kindleFormat: 'azw3' })
  })

  test('reads a persisted format back', () => {
    // Arrange
    writeRawSettings({ kindleFormat: 'mobi' })

    // Act
    const settings = getSettings()

    // Assert
    expect(settings.kindleFormat).toBe('mobi')
  })

  test('falls back to the AZW3 default on malformed JSON instead of throwing', () => {
    writeFileSync(settingsPath(), '{ not valid json', 'utf-8')
    expect(getSettings()).toEqual({ kindleFormat: 'azw3' })
  })

  test('falls back to the AZW3 default when kindleFormat is an unknown value', () => {
    writeRawSettings({ kindleFormat: 'pdf' })
    expect(getSettings().kindleFormat).toBe('azw3')
  })

  test('falls back to the AZW3 default when the parsed root is not an object', () => {
    writeRawSettings(['mobi'])
    expect(getSettings().kindleFormat).toBe('azw3')
  })
})

describe('setKindleFormat — validated, atomic persistence', () => {
  test('persists AZW3 and reads it back', () => {
    // Act
    setKindleFormat('azw3')

    // Assert
    expect(getSettings().kindleFormat).toBe('azw3')
  })

  test('persists MOBI and reads it back', () => {
    setKindleFormat('mobi')
    expect(getSettings().kindleFormat).toBe('mobi')
  })

  test('round-trips a change (mobi → azw3)', () => {
    setKindleFormat('mobi')
    expect(getSettings().kindleFormat).toBe('mobi')

    setKindleFormat('azw3')
    expect(getSettings().kindleFormat).toBe('azw3')
  })

  test('throws a TypeError on an invalid format', () => {
    // @ts-expect-error — deliberately passing an invalid value to test the boundary guard.
    expect(() => setKindleFormat('epub')).toThrow(TypeError)
  })

  test('does not write the file when the format is invalid', () => {
    try {
      // @ts-expect-error — deliberately invalid.
      setKindleFormat('epub')
    } catch {
      // expected
    }
    expect(existsSync(settingsPath())).toBe(false)
  })

  test('leaves no orphaned .tmp file after a successful write', () => {
    setKindleFormat('mobi')
    expect(existsSync(`${settingsPath()}.tmp`)).toBe(false)
  })

  test('writes valid JSON that a plain reader can parse', () => {
    setKindleFormat('mobi')
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
    expect(parsed).toMatchObject({ kindleFormat: 'mobi' })
  })
})
