import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  GLOBAL_MAX_CONCURRENCY,
  hostKey,
  noteRateLimited,
  resetScheduler,
  schedule
} from '../src/main/requestScheduler'

// A promise we can settle from the outside — lets a scheduled task "run"
// indefinitely so we can observe how many are active at once.
function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetScheduler()
})

afterEach(() => {
  resetScheduler()
  vi.useRealTimers()
})

describe('hostKey', () => {
  test('collapses CDN subdomains into shared buckets and lowercases', () => {
    expect(hostKey('is1-ssl.mzstatic.com')).toBe('mzstatic.com')
    expect(hostKey('is5-ssl.mzstatic.com')).toBe('mzstatic.com')
    expect(hostKey('lh3.googleusercontent.com')).toBe('googleusercontent.com')
    expect(hostKey('openlibrary.org')).toBe('openlibrary.org')
    expect(hostKey('ITUNES.APPLE.COM')).toBe('itunes.apple.com')
  })
})

describe('schedule — concurrency', () => {
  test('never runs more than GLOBAL_MAX_CONCURRENCY tasks at once', async () => {
    let active = 0
    let peak = 0
    const deferreds: Array<{ resolve: () => void }> = []

    // 10 distinct hosts (default limit: concurrency 2), one task each. The
    // per-host cap can never be the binding constraint here, so only the global
    // cap limits how many run together.
    for (let i = 0; i < 10; i++) {
      const d = deferred()
      deferreds.push({ resolve: () => d.resolve() })
      void schedule(
        () => {
          active++
          peak = Math.max(peak, active)
          return d.promise.finally(() => {
            active--
          })
        },
        { host: `host${i}.example.com` }
      )
    }

    await vi.advanceTimersByTimeAsync(0)

    expect(active).toBe(GLOBAL_MAX_CONCURRENCY)
    expect(peak).toBe(GLOBAL_MAX_CONCURRENCY)

    // Drain so nothing leaks into the next test.
    deferreds.forEach((d) => d.resolve())
    await vi.advanceTimersByTimeAsync(2000)
  })

  test('serializes a concurrency-1 host (openlibrary.org)', async () => {
    let active = 0
    let peak = 0
    const ds = [deferred(), deferred(), deferred()]
    ds.forEach((d) => {
      void schedule(
        () => {
          active++
          peak = Math.max(peak, active)
          return d.promise.finally(() => {
            active--
          })
        },
        { host: 'openlibrary.org' }
      )
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(active).toBe(1)

    ds[0].resolve()
    await vi.advanceTimersByTimeAsync(1000) // gap for openlibrary.org
    expect(active).toBe(1)

    ds[1].resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(active).toBe(1)

    ds[2].resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(peak).toBe(1)
  })
})

describe('schedule — per-host gap', () => {
  test('spaces consecutive starts on the same host by at least minGapMs', async () => {
    const starts: number[] = []
    const ds = [deferred(), deferred(), deferred()]
    ds.forEach((d) => {
      void schedule(
        () => {
          starts.push(Date.now())
          return d.promise
        },
        { host: 'openlibrary.org' } // minGapMs = 1000, concurrency 1
      )
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toHaveLength(1)

    ds[0].resolve()
    await vi.advanceTimersByTimeAsync(0) // flush settle → scheduler arms the gap timer
    expect(starts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toHaveLength(1) // gap not elapsed yet

    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toHaveLength(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000)

    ds[1].resolve()
    ds[2].resolve()
    await vi.advanceTimersByTimeAsync(2000)
  })
})

describe('schedule — abort', () => {
  test('rejects immediately (AbortError) when the signal is already aborted, without running', async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const p = schedule(
      () => {
        ran = true
        return Promise.resolve()
      },
      { host: 'openlibrary.org', signal: controller.signal }
    )
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(ran).toBe(false)
  })

  test('aborting a queued task rejects with AbortError and never runs it', async () => {
    const dA = deferred()
    // Occupy the single openlibrary slot so B stays queued.
    void schedule(() => dA.promise, { host: 'openlibrary.org' })
    await vi.advanceTimersByTimeAsync(0)

    let bRan = false
    const controller = new AbortController()
    const bPromise = schedule(
      () => {
        bRan = true
        return Promise.resolve()
      },
      { host: 'openlibrary.org', signal: controller.signal }
    )

    controller.abort()
    await expect(bPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(bRan).toBe(false)

    dA.resolve()
    await vi.advanceTimersByTimeAsync(2000)
  })
})

describe('noteRateLimited — per-host isolation', () => {
  test('pauses only the offending host; other hosts keep running', async () => {
    const itunesStarts: number[] = []
    const olStarts: number[] = []

    noteRateLimited('itunes.apple.com', 5000)

    const dI = deferred()
    const dO = deferred()
    void schedule(
      () => {
        itunesStarts.push(Date.now())
        return dI.promise
      },
      { host: 'itunes.apple.com' }
    )
    void schedule(
      () => {
        olStarts.push(Date.now())
        return dO.promise
      },
      { host: 'openlibrary.org' }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(olStarts).toHaveLength(1) // unaffected by the iTunes 429
    expect(itunesStarts).toHaveLength(0) // paused

    await vi.advanceTimersByTimeAsync(5000)
    expect(itunesStarts).toHaveLength(1) // resumes after the pause window

    dI.resolve()
    dO.resolve()
    await vi.advanceTimersByTimeAsync(1000)
  })
})
