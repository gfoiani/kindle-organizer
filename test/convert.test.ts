import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import './setup/electron-mock' // app.isPackaged = false

// The whole point of the native converter: it must never shell out to calibre.
const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock, execFileSync: execFileMock }))
vi.mock('child_process', () => ({ execFile: execFileMock, spawn: spawnMock, execFileSync: execFileMock }))

import { convert } from '../src/main/convert'
import { AppError } from '../src/main/appErrors'
import { JPEG, PNG, writeEpubBook, type EpubBookSpec } from './setup/epubBookFixture'
import { exthStrings, readKf8 } from './setup/kf8Reader'

const BOOK_ID = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-convert-'))
  execFileMock.mockReset()
  spawnMock.mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const SPEC: EpubBookSpec = {
  title: 'Titolo EPUB',
  author: 'Autore EPUB',
  language: 'it',
  docs: [
    { path: 'a.xhtml', body: '<h1>Uno</h1><p><a href="b.xhtml#x">vai</a></p>' },
    { path: 'b.xhtml', body: '<h1>Due</h1><p id="x">Città</p>' }
  ],
  images: [{ path: 'cover.jpg', data: JPEG, cover: true }]
}

function epub(spec: EpubBookSpec = SPEC): string {
  return writeEpubBook(path.join(dir, 'in.epub'), spec)
}

describe('convert', () => {
  test('writes an AZW3 to the output path without running any external program', async () => {
    // Arrange
    const outputPath = path.join(dir, 'out.azw3')

    // Act
    const result = await convert(epub(), { outputPath })

    // Assert
    expect(result).toBe(outputPath)
    const kf8 = readKf8(readFileSync(outputPath))
    expect(kf8.parts).toHaveLength(2)
    expect(kf8.parts[1]).toContain('<p id="x">Città</p>')
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test("stamps the app's title, author, identifier and cover into the book", async () => {
    const coverPath = path.join(dir, 'app-cover.png')
    writeFileSync(coverPath, PNG)
    const outputPath = path.join(dir, 'out.azw3')

    await convert(epub(), {
      outputPath,
      metadata: { title: 'Titolo App', author: 'Autore App', coverPath, identifier: BOOK_ID }
    })

    const kf8 = readKf8(readFileSync(outputPath))
    expect(kf8.header.fullName).toBe('Titolo App')
    expect(exthStrings(kf8.header, 100)).toEqual(['Autore App'])
    expect(exthStrings(kf8.header, 113)).toEqual([BOOK_ID])
    expect(kf8.images[0]).toEqual(PNG)
    expect(exthStrings(kf8.header, 129)).toEqual(['kindle:embed:0001'])
  })

  test("keeps the EPUB's own cover when the app's cover file cannot be read", async () => {
    const outputPath = path.join(dir, 'out.azw3')

    await convert(epub(), { outputPath, metadata: { coverPath: path.join(dir, 'missing.jpg') } })

    const kf8 = readKf8(readFileSync(outputPath))
    expect(kf8.images[0]).toEqual(JPEG)
  })

  test('replaces the output atomically and leaves no temporary file behind', async () => {
    const outputPath = path.join(dir, 'out.azw3')
    writeFileSync(outputPath, 'stale')

    await convert(epub(), { outputPath })

    expect(readFileSync(outputPath).subarray(60, 68).toString('latin1')).toBe('BOOKMOBI')
    expect(readdirSync(dir).sort()).toEqual(['in.epub', 'out.azw3'])
  })

  test('reports progress that ends at 100%', async () => {
    const seen: number[] = []

    await convert(epub(), { outputPath: path.join(dir, 'out.azw3'), onProgress: (p) => seen.push(p) })

    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(100)
  })

  test('rejects a DRM-protected EPUB with EPUB_DRM_PROTECTED', async () => {
    const drm = epub({
      ...SPEC,
      extraEntries: [{ name: 'META-INF/rights.xml', data: Buffer.from('<rights/>') }]
    })

    const error = await convert(drm, { outputPath: path.join(dir, 'out.azw3') }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('EPUB_DRM_PROTECTED')
    expect(existsSync(path.join(dir, 'out.azw3'))).toBe(false)
  })

  test('rejects a file that is not an EPUB with EPUB_INVALID', async () => {
    const notEpub = path.join(dir, 'in.epub')
    writeFileSync(notEpub, 'plain text')

    const error = await convert(notEpub, { outputPath: path.join(dir, 'out.azw3') }).catch((e: unknown) => e)

    expect((error as AppError).code).toBe('EPUB_INVALID')
  })

  test('rejects with an AbortError when cancelled, writing nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const outputPath = path.join(dir, 'out.azw3')

    const error = await convert(epub(), { outputPath, signal: controller.signal }).catch((e: unknown) => e)

    expect((error as Error).name).toBe('AbortError')
    expect(existsSync(outputPath)).toBe(false)
  })
})
