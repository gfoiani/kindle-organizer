/**
 * Concurrency-limited, per-host rate-limited request scheduler.
 *
 * Replaces the old single serial queue. The scheduled unit is ONE HTTP
 * round-trip (see httpClient.fetchUrl), not a whole book download — so covers
 * for different books hit different hosts in parallel while calls to the same
 * host stay gap-limited, and a redirect never holds a slot across its next hop.
 *
 * Determinism: `pump()` runs after every enqueue/settle and arms exactly ONE
 * shared timer for the next time-eligible instant (no polling), so the whole
 * thing is testable with fake timers.
 */

export interface HostLimit {
  /** Max simultaneous in-flight requests to this host. */
  concurrency: number
  /** Minimum wall-clock gap between two consecutive starts on this host. */
  minGapMs: number
}

/** Hard ceiling on total in-flight requests across all hosts. */
export const GLOBAL_MAX_CONCURRENCY = 6

const DEFAULT_HOST_LIMIT: HostLimit = { concurrency: 2, minGapMs: 500 }

// Conservative per-host limits. Search endpoints (iTunes/OpenLibrary) are the
// most 429-prone, so they get low concurrency + big gaps; CDN image hosts are
// cheap and bucketed (see hostKey) with high concurrency + tiny gaps.
const HOST_LIMITS: Record<string, HostLimit> = {
  'itunes.apple.com': { concurrency: 1, minGapMs: 3000 },
  'openlibrary.org': { concurrency: 1, minGapMs: 1000 },
  'www.googleapis.com': { concurrency: 2, minGapMs: 500 },
  'books.google.com': { concurrency: 2, minGapMs: 500 },
  'covers.openlibrary.org': { concurrency: 3, minGapMs: 250 },
  'mzstatic.com': { concurrency: 4, minGapMs: 100 },
  'googleusercontent.com': { concurrency: 4, minGapMs: 100 }
}

/** Rejection used for tasks aborted before/while queued. Matches the DOM name. */
export class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

interface Task {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface HostState {
  queue: Task[]
  active: number
  /** Epoch ms of the most recent start on this host (0 = never started). */
  lastStart: number
  /** Epoch ms until which this host is paused (429 backoff). */
  pausedUntil: number
}

const hosts = new Map<string, HostState>()
let globalActive = 0
let timer: ReturnType<typeof setTimeout> | null = null
// Bumped by resetScheduler so settles of pre-reset in-flight tasks don't
// corrupt the fresh counters.
let generation = 0

/** Collapses CDN subdomains into a single bucket; lowercases everything else. */
export function hostKey(hostname: string): string {
  const h = hostname.toLowerCase()
  if (h === 'mzstatic.com' || h.endsWith('.mzstatic.com')) return 'mzstatic.com'
  if (h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com')) {
    return 'googleusercontent.com'
  }
  return h
}

function limitFor(key: string): HostLimit {
  return HOST_LIMITS[key] ?? DEFAULT_HOST_LIMIT
}

function hostStateFor(key: string): HostState {
  let state = hosts.get(key)
  if (!state) {
    state = { queue: [], active: 0, lastStart: 0, pausedUntil: 0 }
    hosts.set(key, state)
  }
  return state
}

function startTask(state: HostState, task: Task): void {
  state.active++
  globalActive++
  state.lastStart = Date.now()
  const gen = generation

  // The task is leaving the queue; the queue-drop abort listener no longer
  // applies (an in-flight abort is handled downstream by the socket teardown).
  if (task.signal && task.onAbort) {
    task.signal.removeEventListener('abort', task.onAbort)
  }

  Promise.resolve()
    .then(() => task.run())
    .then(task.resolve, task.reject)
    .finally(() => {
      if (gen === generation) {
        state.active--
        globalActive--
      }
      pump()
    })
}

function pump(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }

  const now = Date.now()
  let nextWake = Infinity

  for (const [key, state] of hosts) {
    if (state.queue.length === 0) continue
    const limit = limitFor(key)

    while (
      state.queue.length > 0 &&
      globalActive < GLOBAL_MAX_CONCURRENCY &&
      state.active < limit.concurrency
    ) {
      const readyAt = Math.max(state.pausedUntil, state.lastStart + limit.minGapMs)
      if (now < readyAt) {
        nextWake = Math.min(nextWake, readyAt)
        break // this host is time-blocked; other hosts may still start
      }
      const task = state.queue.shift()!
      startTask(state, task)
    }
  }

  // Only a time-based wait needs a timer. Concurrency-based waits are re-driven
  // by task settles. If the global cap is the blocker, a settle will re-pump.
  if (nextWake !== Infinity && globalActive < GLOBAL_MAX_CONCURRENCY) {
    timer = setTimeout(() => {
      timer = null
      pump()
    }, Math.max(0, nextWake - Date.now()))
  }
}

/**
 * Schedules a single HTTP round-trip against `host`, respecting the global and
 * per-host concurrency/gap limits. Resolves/rejects with whatever `task` does.
 *
 * Abort semantics:
 *  - signal already aborted → rejects immediately with AbortError, never enqueued
 *  - aborted while queued → removed from the queue, `task` never called, rejects AbortError
 *  - aborted while in flight → left to the task itself (socket teardown)
 */
export function schedule<T>(
  task: () => Promise<T>,
  opts: { host: string; signal?: AbortSignal }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AbortError())
      return
    }

    const key = hostKey(opts.host)
    const state = hostStateFor(key)
    const entry: Task = {
      run: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject
    }

    if (opts.signal) {
      const signal = opts.signal
      const onAbort = (): void => {
        const idx = state.queue.indexOf(entry)
        if (idx !== -1) {
          state.queue.splice(idx, 1)
          reject(new AbortError())
        }
      }
      entry.signal = signal
      entry.onAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }

    state.queue.push(entry)
    pump()
  })
}

/**
 * Records a 429 (or explicit Retry-After) for a host, pausing ONLY that host
 * until the window elapses. Other hosts keep running.
 */
export function noteRateLimited(host: string, retryAfterMs: number): void {
  const state = hostStateFor(hostKey(host))
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + retryAfterMs)
  pump()
}

/**
 * Drops every queued task (rejecting with AbortError) and clears all per-host
 * state and the shared timer. In-flight tasks are NOT force-settled here — their
 * AbortControllers (owned by covers.ts) tear down the sockets — but the
 * generation bump ensures their late settles can't corrupt the fresh counters.
 */
export function resetScheduler(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  for (const state of hosts.values()) {
    for (const task of state.queue) {
      if (task.signal && task.onAbort) {
        task.signal.removeEventListener('abort', task.onAbort)
      }
      task.reject(new AbortError())
    }
    state.queue = []
  }
  hosts.clear()
  globalActive = 0
  generation++
}
