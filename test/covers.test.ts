import * as crypto from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'

// Network tripwires + controllable mock: ensureCover must never touch the
// network on a cache hit; when it does download we drive it via httpMock.
// `http.get`/`https.get` can't be spied on in ESM, so mock the modules outright.
const { httpGet, httpsGet } = vi.hoisted(() => ({ httpGet: vi.fn(), httpsGet: vi.fn() }))
vi.mock('http', () => ({ get: httpGet }))
vi.mock('https', () => ({ get: httpsGet }))

import { cancelAllCovers, clearCoverCache, ensureCover, setCoverWindowProvider } from '../src/main/covers'
import { httpGetImpl, mockRoute, resetHttpMock } from './setup/httpMock'

let userData: string

/**
 * Re-derives the on-disk cache path for (title, author, isbn) using the SAME
 * scheme coverPaths.ts uses: sha256 of `title|author` (lowercased + trimmed),
 * with a `|isbn` segment appended ONLY when a valid ISBN is present. Keeping
 * this in lock-step lets us seed/inspect the cache without exporting internals.
 */
function cacheKeyFor(title: string, author: string | undefined, isbn?: string): string {
  const base = `${title.toLowerCase().trim()}|${(author ?? '').toLowerCase().trim()}`
  const cleaned = typeof isbn === 'string' ? isbn.replace(/[^0-9Xx]/g, '').toUpperCase() : ''
  const isbnPart = cleaned.length === 10 || cleaned.length === 13 ? cleaned : ''
  const normalized = isbnPart ? `${base}|${isbnPart}` : base
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function cachePathFor(title: string, author: string | undefined, isbn?: string): string {
  return path.join(userData, 'covers', `${cacheKeyFor(title, author, isbn)}.jpg`)
}

/** Smallest buffer covers.ts treats as a real JPEG (FF D8 FF magic, >= MIN_IMAGE_BYTES). */
function fakeJpeg(): Buffer {
  const buf = Buffer.alloc(600, 0x20)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  return buf
}

beforeEach(async () => {
  userData = freshUserData()
  setCoverWindowProvider(() => null) // isolate: no window unless a test opts in
  cancelAllCovers()
  await clearCoverCache()
  resetHttpMock()
  httpGet.mockReset()
  httpsGet.mockReset()
  httpGet.mockImplementation(httpGetImpl)
  httpsGet.mockImplementation(httpGetImpl)
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('ensureCover — disk-served status, no network', () => {
  test('returns { status: "ready" } for a seeded cache file without any network call', async () => {
    const title = 'The Pragmatic Programmer'
    const author = 'Hunt Thomas'
    const cachePath = cachePathFor(title, author)
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, fakeJpeg())

    const result = await ensureCover(title, author)

    expect(result).toEqual({ key: cacheKeyFor(title, author), status: 'ready' })
    expect(httpGet).not.toHaveBeenCalled()
    expect(httpsGet).not.toHaveBeenCalled()
  })

  test('returns { status: "missing" } for a negative-cache marker (empty file), no network', async () => {
    const title = 'No Cover Book'
    const cachePath = cachePathFor(title, undefined)
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, Buffer.alloc(0))

    const result = await ensureCover(title, undefined)

    expect(result).toEqual({ key: cacheKeyFor(title, undefined), status: 'missing' })
    expect(httpGet).not.toHaveBeenCalled()
    expect(httpsGet).not.toHaveBeenCalled()
  })

  test('returns { status: "pending" } for an uncached book without blocking on the network', async () => {
    // No route registered → the background download fails fast and self-cleans.
    const result = await ensureCover('Some Uncached Title', 'Nobody')
    expect(result.status).toBe('pending')
    expect(result.key).toMatch(/^[0-9a-f]{64}$/)
    // Let the background work settle, then clean up.
    await new Promise((r) => setTimeout(r, 10))
    cancelAllCovers()
  })
})

describe('ensureCover — ISBN in the cache key', () => {
  test('a cover seeded under the ISBN key is a hit only when the ISBN matches', async () => {
    const title = 'Clean Code'
    const author = 'Robert Martin'
    const isbn = '9780132350884'
    const cachePath = cachePathFor(title, author, isbn)
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, fakeJpeg())

    // Same ISBN → hit.
    await expect(ensureCover(title, author, isbn)).resolves.toEqual({
      key: cacheKeyFor(title, author, isbn),
      status: 'ready'
    })

    // No ISBN → different key → not a hit (pending, then cancel the bg work).
    const noIsbn = await ensureCover(title, author)
    expect(noIsbn.key).not.toBe(cacheKeyFor(title, author, isbn))
    expect(noIsbn.status).toBe('pending')

    // Different ISBN → different key → not a hit.
    const otherIsbn = await ensureCover(title, author, '9781491950296')
    expect(otherIsbn.key).not.toBe(cacheKeyFor(title, author, isbn))
    expect(otherIsbn.status).toBe('pending')

    await new Promise((r) => setTimeout(r, 10))
    cancelAllCovers()
  })
})

describe('ensureCover — background download + notifyCoverReady', () => {
  test('downloads via ISBN, caches the file, and pushes ("cover:updated", key)', async () => {
    const title = 'Refactoring'
    const author = 'Martin Fowler'
    const isbn = '9780201485677'
    const key = cacheKeyFor(title, author, isbn)
    const isbnUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
    mockRoute(isbnUrl, { statusCode: 200, body: fakeJpeg() })

    const send = vi.fn()
    setCoverWindowProvider(() => ({ isDestroyed: () => false, webContents: { send } }) as never)

    const result = await ensureCover(title, author, isbn)
    expect(result).toEqual({ key, status: 'pending' })

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('cover:updated', key))
    // The file is on disk and holds the downloaded bytes.
    const onDisk = readFileSync(cachePathFor(title, author, isbn))
    expect(onDisk.equals(fakeJpeg())).toBe(true)
  })
})

describe('clearCoverCache — async cache clearing', () => {
  test('removes every cached cover file via the async path', async () => {
    const coversDir = path.join(userData, 'covers')
    mkdirSync(coversDir, { recursive: true })
    writeFileSync(path.join(coversDir, 'a'.repeat(64) + '.jpg'), fakeJpeg())
    writeFileSync(path.join(coversDir, 'b'.repeat(64) + '.jpg'), Buffer.alloc(0))
    expect(readdirSync(coversDir)).toHaveLength(2)

    await clearCoverCache()

    expect(existsSync(coversDir)).toBe(true)
    expect(readdirSync(coversDir)).toHaveLength(0)
  })

  test('resolves without throwing when the cache dir does not exist', async () => {
    expect(existsSync(path.join(userData, 'covers'))).toBe(false)
    await expect(clearCoverCache()).resolves.toBeUndefined()
  })
})
