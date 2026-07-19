import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { handleCoverRequest } from '../src/main/coverProtocol'

let userData: string
const VALID_KEY = 'a'.repeat(64) // sha256-shaped (64 lowercase hex)

function seed(key: string, bytes: Buffer): void {
  const dir = path.join(userData, 'covers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${key}.jpg`), bytes)
}

/** handleCoverRequest only reads request.url, so a minimal shape is enough. */
function request(url: string): Request {
  return { url } as unknown as Request
}

function jpeg(): Buffer {
  const buf = Buffer.alloc(64, 0x20)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  return buf
}

beforeEach(() => {
  userData = freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('handleCoverRequest — happy path', () => {
  test('streams a seeded cover with 200, image/jpeg and immutable caching', async () => {
    const bytes = jpeg()
    seed(VALID_KEY, bytes)

    const res = await handleCoverRequest(request(`cover-cache://covers/${VALID_KEY}?v=1`))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toContain('immutable')

    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(bytes)).toBe(true)
  })
})

describe('handleCoverRequest — 404s', () => {
  test('returns 404 for a zero-byte negative-cache marker', async () => {
    seed(VALID_KEY, Buffer.alloc(0))
    const res = await handleCoverRequest(request(`cover-cache://covers/${VALID_KEY}`))
    expect(res.status).toBe(404)
  })

  test('returns 404 when the file does not exist', async () => {
    const res = await handleCoverRequest(request(`cover-cache://covers/${'b'.repeat(64)}`))
    expect(res.status).toBe(404)
  })

  test('returns 404 for a wrong host even with a valid key', async () => {
    seed(VALID_KEY, jpeg())
    const res = await handleCoverRequest(request(`cover-cache://evil/${VALID_KEY}`))
    expect(res.status).toBe(404)
  })
})

describe('handleCoverRequest — path-traversal guard → 400', () => {
  // Every one of these must be rejected BEFORE any filesystem access.
  const attacks: Array<[string, string]> = [
    ['dot-dot path', 'cover-cache://covers/../../etc/passwd'],
    ['encoded dot-dot', 'cover-cache://covers/%2e%2e%2fsecret'],
    ['too short (63)', `cover-cache://covers/${'a'.repeat(63)}`],
    ['too long (65)', `cover-cache://covers/${'a'.repeat(65)}`],
    ['uppercase hex', `cover-cache://covers/${'A'.repeat(64)}`],
    ['non-hex', `cover-cache://covers/${'g'.repeat(64)}`],
    ['empty key', 'cover-cache://covers/'],
    ['nested path', `cover-cache://covers/sub/${'a'.repeat(64)}`]
  ]

  test.each(attacks)('rejects %s with 400', async (_label, url) => {
    // Seed a real file so a bug that ignored the guard would return 200, not 404.
    seed(VALID_KEY, jpeg())
    const res = await handleCoverRequest(request(url))
    expect(res.status).toBe(400)
  })
})
