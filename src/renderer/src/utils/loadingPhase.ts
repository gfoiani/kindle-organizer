/** What the grid is waiting for while the device state is still unknown. */
export type LoadingPhase = 'detecting' | 'reading'

export interface DeviceLoadState {
  /** False until the first detect + scan cycle has completed (either outcome). */
  hasResolvedDevice: boolean
  /** A drive detection is in flight. */
  isDetectingDrive: boolean
  /** A device documents scan is in flight. */
  isReadingBooks: boolean
}

/**
 * Decides whether the grid must hold back its content, and what to say while it
 * does.
 *
 * The staging library loads from local SQLite in milliseconds; the device takes
 * seconds (drive detection, then a full `documents/` scan). Presence — the
 * on-device vs library-only split — can only be computed once BOTH are in, so
 * rendering the library alone paints a state that is not merely partial but
 * wrong: an already-uploaded book shows as "library only" until the scan lands,
 * then silently reconciles into its device card. Hence: block on the FIRST
 * cycle, whatever is already in hand.
 *
 * Every later reload returns null — stale-while-revalidate. Blanking a
 * populated grid for two seconds on every refresh trades one honest wait for a
 * recurring one, and what is on screen stays true while it revalidates.
 */
export function selectLoadingPhase(state: DeviceLoadState): LoadingPhase | null {
  if (state.hasResolvedDevice) return null
  return state.isReadingBooks ? 'reading' : 'detecting'
}
