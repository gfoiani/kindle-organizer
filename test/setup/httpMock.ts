import { EventEmitter } from 'events'

/**
 * A tiny router-based mock for Node's `http.get` / `https.get`, good enough to
 * exercise httpClient.fetchRaw's contract: it emulates a `ClientRequest`
 * (destroyable EventEmitter emitting `error`/`timeout`) and an
 * `IncomingMessage` (statusCode/headers, emitting `data`/`end`).
 *
 * Tests register per-URL responses with `mockRoute` and wire `httpGetImpl` as
 * the implementation of hoisted `vi.fn()` spies for the `http`/`https` modules.
 */

export interface MockResponse {
  statusCode?: number
  headers?: Record<string, string>
  body?: string | Buffer
  /** Emit a socket error or timeout instead of a normal response. */
  fail?: 'error' | 'timeout'
  /** Deliver the response head but never end the body — stays in-flight until aborted. */
  hang?: boolean
}

class FakeClientRequest extends EventEmitter {
  destroyed = false
  destroy(err?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    if (err) queueMicrotask(() => this.emit('error', err))
    return this
  }
}

class FakeIncomingMessage extends EventEmitter {
  constructor(
    public statusCode: number,
    public headers: Record<string, string>
  ) {
    super()
  }
}

const routes = new Map<string, MockResponse>()

/** Registers the response returned for an exact URL. */
export function mockRoute(url: string, response: MockResponse): void {
  routes.set(url, response)
}

/** Clears all registered routes (call in beforeEach). */
export function resetHttpMock(): void {
  routes.clear()
}

/** Drop-in for `http.get` / `https.get` — `get(url, options, callback)`. */
export function httpGetImpl(
  url: string,
  _options: unknown,
  callback: (res: FakeIncomingMessage) => void
): FakeClientRequest {
  const req = new FakeClientRequest()
  const route = routes.get(url)

  queueMicrotask(() => {
    if (req.destroyed) return
    if (!route) {
      req.emit('error', new Error(`httpMock: no route registered for ${url}`))
      return
    }
    if (route.fail === 'timeout') {
      req.emit('timeout')
      return
    }
    if (route.fail === 'error') {
      req.emit('error', new Error('httpMock: simulated socket error'))
      return
    }

    const res = new FakeIncomingMessage(route.statusCode ?? 200, route.headers ?? {})
    callback(res)
    if (route.hang) return

    const raw = route.body ?? Buffer.alloc(0)
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : raw
    queueMicrotask(() => {
      if (req.destroyed) return
      if (buf.length > 0) res.emit('data', buf)
      res.emit('end')
    })
  })

  return req
}
