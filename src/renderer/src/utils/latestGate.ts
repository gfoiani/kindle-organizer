/** Hands out one ticket per load; a ticket says whether its load is still the newest. */
export interface LatestGate {
  begin: () => () => boolean
}

/**
 * For loads that can overlap (a push and a window focus both reloading the
 * library): IPC replies may arrive in any order, so only the load started last
 * may apply its result — an older reply landing later would show stale data.
 */
export function createLatestGate(): LatestGate {
  let latest = 0
  return {
    begin: () => {
      const ticket = ++latest
      return () => ticket === latest
    }
  }
}
