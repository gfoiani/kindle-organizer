import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import './setup/electron-mock' // app.isPackaged = false

// Controllable child_process + fs so detection and spawning are fully driven.
const { execFileMock, execFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFile: execFileMock, execFileSync: execFileSyncMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

import {
  convert,
  detectEngine,
  resetEngineCache,
  ConversionUnavailableError,
  UnsupportedFormatError,
  ConversionFailedError
} from '../src/main/convert'

/** A fake ChildProcess we can drive from the test. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill = vi.fn((): boolean => {
    this.killed = true
    return true
  })
}

const CALIBRE_MAC = '/Applications/calibre.app/Contents/MacOS/ebook-convert'

/** Configures existsSync to return true only for the given paths. */
function setExisting(paths: string[]): void {
  const set = new Set(paths)
  existsSyncMock.mockImplementation((p: string) => set.has(p))
}

beforeEach(() => {
  resetEngineCache()
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
  existsSyncMock.mockReset()
})

afterEach(() => {
  resetEngineCache()
})

describe('detectEngine', () => {
  test('detects calibre when the canonical macOS binary exists', () => {
    setExisting([CALIBRE_MAC])
    expect(detectEngine()).toBe('calibre')
  })

  test('returns "none" when no calibre and no bundled binary exist', () => {
    setExisting([])
    execFileSyncMock.mockImplementation(() => {
      throw new Error('command not found')
    })
    expect(detectEngine()).toBe('none')
  })
})

describe('convert — calibre engine', () => {
  test('spawns ebook-convert with the kindle profile argv and resolves the output path', async () => {
    setExisting([CALIBRE_MAC])
    const child = new FakeChild()
    execFileMock.mockReturnValue(child)

    const p = convert('/in/book.epub', 'azw3', { outputPath: '/out/book.azw3' })
    child.emit('close', 0)

    await expect(p).resolves.toBe('/out/book.azw3')
    expect(execFileMock).toHaveBeenCalledWith(
      CALIBRE_MAC,
      ['/in/book.epub', '/out/book.azw3', '--output-profile', 'kindle_pw3'],
      expect.any(Object)
    )
  })

  test('reports progress from a tolerant "\\d+%" match on stderr', async () => {
    setExisting([CALIBRE_MAC])
    const child = new FakeChild()
    execFileMock.mockReturnValue(child)
    const onProgress = vi.fn()

    const p = convert('/in/book.epub', 'azw3', { outputPath: '/out/book.azw3', onProgress })
    child.stderr.emit('data', Buffer.from('45% Converting input'))
    child.emit('close', 0)

    await p
    expect(onProgress).toHaveBeenCalledWith(45)
  })

  test('rejects with ConversionFailedError (code + stderr tail) on a non-zero exit', async () => {
    setExisting([CALIBRE_MAC])
    const child = new FakeChild()
    execFileMock.mockReturnValue(child)

    const p = convert('/in/book.epub', 'azw3', { outputPath: '/out/book.azw3' })
    child.stderr.emit('data', Buffer.from('boom: bad input'))
    child.emit('close', 1)

    await expect(p).rejects.toBeInstanceOf(ConversionFailedError)
    await expect(p).rejects.toMatchObject({ code: 1, stderrTail: expect.stringContaining('boom') })
  })

  test('cancels via AbortSignal: kills the child and rejects with an AbortError', async () => {
    setExisting([CALIBRE_MAC])
    const child = new FakeChild()
    execFileMock.mockReturnValue(child)
    const controller = new AbortController()

    const p = convert('/in/book.epub', 'azw3', {
      outputPath: '/out/book.azw3',
      signal: controller.signal
    })
    controller.abort()
    child.emit('close', null)

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalled()
  })
})

describe('convert — engine guards', () => {
  test('rejects MOBI on the bundled engine with UnsupportedFormatError (no spawn)', async () => {
    const bundled = `${process.cwd()}/resources/converter/kindle-cli`
    setExisting([bundled]) // no calibre → bundled
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found') // PATH probe fails → calibre not found
    })

    const p = convert('/in/book.epub', 'mobi', { outputPath: '/out/book.mobi' })

    await expect(p).rejects.toBeInstanceOf(UnsupportedFormatError)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  test('rejects with ConversionUnavailableError when no engine is available', async () => {
    setExisting([])
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found')
    })

    const p = convert('/in/book.epub', 'azw3', { outputPath: '/out/book.azw3' })

    await expect(p).rejects.toBeInstanceOf(ConversionUnavailableError)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
