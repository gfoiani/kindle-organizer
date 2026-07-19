import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// http.get / https.get can't be spied on in ESM, so mock the modules outright.
// vi.hoisted lets the hoisted vi.mock factories reference the shared spies.
const { httpGet, httpsGet } = vi.hoisted(() => ({ httpGet: vi.fn(), httpsGet: vi.fn() }))
vi.mock('http', () => ({ get: httpGet }))
vi.mock('https', () => ({ get: httpsGet }))

import {
  AbortError,
  NetworkError,
  fetchJson,
  fetchUrl,
  fetchUrlWithRetry,
  isAllowedHost
} from '../src/main/httpClient'
import { resetScheduler } from '../src/main/requestScheduler'
import { httpGetImpl, mockRoute, resetHttpMock } from './setup/httpMock'

beforeEach(() => {
  resetScheduler()
  resetHttpMock()
  httpGet.mockReset()
  httpsGet.mockReset()
  httpGet.mockImplementation(httpGetImpl)
  httpsGet.mockImplementation(httpGetImpl)
})

afterEach(() => {
  resetScheduler()
})

describe('isAllowedHost', () => {
  test('allows provider/CDN hosts and rejects arbitrary hosts', () => {
    expect(isAllowedHost('itunes.apple.com')).toBe(true)
    expect(isAllowedHost('is1-ssl.mzstatic.com')).toBe(true)
    expect(isAllowedHost('lh3.googleusercontent.com')).toBe(true)
    expect(isAllowedHost('evil.internal')).toBe(false)
    expect(isAllowedHost('openlibrary.org.evil.com')).toBe(false)
  })
})

describe('fetchJson', () => {
  test('returns the parsed object for valid JSON', async () => {
    mockRoute('https://openlibrary.org/x.json', {
      statusCode: 200,
      body: JSON.stringify({ ok: true, n: 3 })
    })
    await expect(fetchJson('https://openlibrary.org/x.json')).resolves.toEqual({ ok: true, n: 3 })
  })

  test('resolves to null on malformed JSON (data loss, not a network error)', async () => {
    mockRoute('https://openlibrary.org/bad.json', { statusCode: 200, body: '{not valid json' })
    await expect(fetchJson('https://openlibrary.org/bad.json')).resolves.toBeNull()
  })
})

describe('fetchUrl — status handling', () => {
  test('surfaces a socket error as NetworkError', async () => {
    mockRoute('https://openlibrary.org/e', { fail: 'error' })
    await expect(fetchUrl('https://openlibrary.org/e')).rejects.toBeInstanceOf(NetworkError)
  })

  test('surfaces a timeout as NetworkError', async () => {
    mockRoute('https://openlibrary.org/t', { fail: 'timeout' })
    await expect(fetchUrl('https://openlibrary.org/t')).rejects.toBeInstanceOf(NetworkError)
  })

  test('throws HttpError carrying the status for a 5xx', async () => {
    mockRoute('https://openlibrary.org/500', { statusCode: 500 })
    await expect(fetchUrl('https://openlibrary.org/500')).rejects.toMatchObject({
      name: 'HttpError',
      status: 500
    })
  })

  test('throws RateLimitError on 429, parsing Retry-After seconds to ms', async () => {
    mockRoute('https://openlibrary.org/429', {
      statusCode: 429,
      headers: { 'retry-after': '2' }
    })
    await expect(fetchUrl('https://openlibrary.org/429')).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 2000
    })
  })
})

describe('fetchUrl — SSRF redirect guard', () => {
  test('rejects a redirect to a disallowed host and never follows it', async () => {
    mockRoute('https://openlibrary.org/redir', {
      statusCode: 302,
      headers: { location: 'https://evil.internal/secret' }
    })
    await expect(fetchUrl('https://openlibrary.org/redir')).rejects.toBeInstanceOf(NetworkError)
    // Only the first hop was dispatched; the evil host was never contacted.
    expect(httpsGet).toHaveBeenCalledTimes(1)
  })
})

describe('fetchUrl — abort', () => {
  test('an already-aborted signal rejects with AbortError without opening a socket', async () => {
    mockRoute('https://openlibrary.org/a', { statusCode: 200, body: 'x' })
    const controller = new AbortController()
    controller.abort()
    await expect(fetchUrl('https://openlibrary.org/a', controller.signal)).rejects.toBeInstanceOf(
      AbortError
    )
    expect(httpsGet).not.toHaveBeenCalled()
  })

  test('aborting in flight rejects with AbortError and does not retry', async () => {
    mockRoute('https://openlibrary.org/hang', { statusCode: 200, hang: true })
    const controller = new AbortController()
    const promise = fetchUrlWithRetry('https://openlibrary.org/hang', controller.signal)
    // Give the scheduled request time to actually open the (hanging) socket.
    await new Promise((r) => setTimeout(r, 10))
    expect(httpsGet).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(promise).rejects.toBeInstanceOf(AbortError)
    expect(httpsGet).toHaveBeenCalledTimes(1) // no retry after an abort
  })
})
