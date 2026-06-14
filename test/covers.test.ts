import * as crypto from 'crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import path from 'path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'

// Network tripwires: getCover must never reach the network on a cache hit.
// `http.get`/`https.get` can't be spied on in ESM (the namespace is not
// configurable), so we mock the modules outright — any call surfaces here.
// `vi.hoisted` lets the hoisted `vi.mock` factories reference these spies.
const { httpGet, httpsGet } = vi.hoisted(() => ({ httpGet: vi.fn(), httpsGet: vi.fn() }))
vi.mock('http', () => ({ get: httpGet }))
vi.mock('https', () => ({ get: httpsGet }))

import { clearCoverCache, getCover } from '../src/main/covers'

let userData: string

/**
 * Re-derives the on-disk cache path for a (title, author) pair using the SAME
 * scheme covers.ts uses internally: sha256 of `title|author` (both lowercased
 * and trimmed) under `<userData>/covers/<hash>.jpg`. Keeping this in lock-step
 * with the module lets us seed the cache from the outside without exporting
 * private helpers from covers.ts.
 */
function cachePathFor(title: string, author: string | undefined): string {
  const normalized = `${title.toLowerCase().trim()}|${(author ?? '').toLowerCase().trim()}`
  const key = crypto.createHash('sha256').update(normalized).digest('hex')
  return path.join(userData, 'covers', `${key}.jpg`)
}

/** Smallest buffer covers.ts will treat as a real JPEG (FF D8 FF magic, >= MIN_IMAGE_BYTES). */
function fakeJpeg(): Buffer {
  const buf = Buffer.alloc(600, 0x20)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  return buf
}

beforeEach(async () => {
  userData = freshUserData()
  // Clear any in-memory retry/in-flight state carried over from a prior test.
  await clearCoverCache()
  httpGet.mockClear()
  httpsGet.mockClear()
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('getCover — async cache-hit fast path', () => {
  test('returns a data: URL from a seeded cache file without any network call', async () => {
    // Arrange — seed a valid JPEG at the exact path covers.ts derives.
    const title = 'The Pragmatic Programmer'
    const author = 'Hunt Thomas'
    const cachePath = cachePathFor(title, author)
    mkdirSync(path.dirname(cachePath), { recursive: true })
    const jpeg = fakeJpeg()
    writeFileSync(cachePath, jpeg)

    // Act
    const result = await getCover(title, author)

    // Assert — round-trips the cached bytes as a base64 data URL.
    expect(result).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    expect(httpGet).not.toHaveBeenCalled()
    expect(httpsGet).not.toHaveBeenCalled()
  })

  test('returns null for a negative-cache marker (empty file) without any network call', async () => {
    // Arrange — a zero-byte file is the "no cover exists" marker.
    const title = 'No Cover Book'
    const author = undefined
    const cachePath = cachePathFor(title, author)
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, Buffer.alloc(0))

    // Act
    const result = await getCover(title, author)

    // Assert
    expect(result).toBeNull()
    expect(httpGet).not.toHaveBeenCalled()
    expect(httpsGet).not.toHaveBeenCalled()
  })
})

describe('clearCoverCache — async cache clearing', () => {
  test('removes every cached cover file via the async path', async () => {
    // Arrange — two seeded cache files.
    const coversDir = path.join(userData, 'covers')
    mkdirSync(coversDir, { recursive: true })
    writeFileSync(path.join(coversDir, 'a'.repeat(64) + '.jpg'), fakeJpeg())
    writeFileSync(path.join(coversDir, 'b'.repeat(64) + '.jpg'), Buffer.alloc(0))
    expect(readdirSync(coversDir)).toHaveLength(2)

    // Act
    await clearCoverCache()

    // Assert — directory still exists but is empty.
    expect(existsSync(coversDir)).toBe(true)
    expect(readdirSync(coversDir)).toHaveLength(0)
  })

  test('resolves without throwing when the cache dir does not exist', async () => {
    // Arrange — fresh userData with no covers dir.
    expect(existsSync(path.join(userData, 'covers'))).toBe(false)

    // Act / Assert
    await expect(clearCoverCache()).resolves.toBeUndefined()
  })
})
