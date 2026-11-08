import type { KindleCollectionSummary, KindleSyncState } from '../../../preload/api'

/**
 * What the header shows for the connected Kindle's collection sync. Pure, so
 * the wording rules are unit-tested; the component only renders the result.
 */

export type KindleSyncTone = 'ok' | 'pending' | 'warning' | 'muted' | 'action'

export interface KindleSyncView {
  tone: KindleSyncTone
  /** i18n key of the short status label. */
  labelKey: string
  /** i18n key of the longer explanation (tooltip). */
  hintKey: string
  hintValues: Record<string, string | number>
  /** The status is a button that opens the first-sync question. */
  opensFirstSync: boolean
  /** The community jailbreak guide, linked while the jailbreak is what is missing; otherwise null. */
  guideUrl: string | null
}

/**
 * Where jb.sh and its install steps are documented. The app only links to it:
 * the jailbreak itself is the user's choice and is never performed by the app.
 */
export const JAILBREAK_GUIDE_URL = 'https://kindlemodding.org/'

function view(tone: KindleSyncTone, labelKey: string, hint?: Partial<Pick<KindleSyncView, 'hintKey' | 'hintValues'>>): KindleSyncView {
  return {
    tone,
    labelKey,
    hintKey: hint?.hintKey ?? `${labelKey}Hint`,
    hintValues: hint?.hintValues ?? {},
    opensFirstSync: false,
    guideUrl: null
  }
}

function describeActive(state: Extract<KindleSyncState, { kind: 'active' }>): KindleSyncView {
  const { status, upToDate } = state
  if (status.result === 'error') {
    return status.error
      ? view('warning', 'kindleSync.failed', { hintValues: { detail: status.error } })
      : view('warning', 'kindleSync.failed', { hintKey: 'kindleSync.failedNoDetailHint' })
  }
  if (!upToDate) return view('pending', 'kindleSync.pending')
  if (status.pendingBooks.length > 0) {
    return view('pending', 'kindleSync.booksPending', { hintValues: { count: status.pendingBooks.length } })
  }
  return view('ok', 'kindleSync.upToDate')
}

export function describeKindleSync(state: KindleSyncState | null): KindleSyncView | null {
  if (state === null) return null
  switch (state.kind) {
    case 'not-jailbroken':
      return { ...view('muted', 'kindleSync.needsJailbreak'), guideUrl: JAILBREAK_GUIDE_URL }
    case 'unsupported-jailbreak':
      return { ...view('muted', 'kindleSync.unsupportedJailbreak'), guideUrl: JAILBREAK_GUIDE_URL }
    case 'not-installed':
      return view('muted', 'kindleSync.notInstalled')
    case 'first-sync':
      return { ...view('action', 'kindleSync.firstSync'), opensFirstSync: true }
    case 'active':
      return describeActive(state)
  }
}

/**
 * Whether to open the first-sync question by itself: as soon as it is due,
 * unless the user already put it off for this Kindle (the status keeps
 * offering it as a button).
 */
export function shouldOfferFirstSync(state: KindleSyncState | null, dismissedDeviceIds: ReadonlySet<string>): boolean {
  return state?.kind === 'first-sync' && !dismissedDeviceIds.has(state.status.deviceId)
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base' })

/** The Kindle's collections in name order, for the first-sync question. */
export function sortKindleCollections(collections: readonly KindleCollectionSummary[]): KindleCollectionSummary[] {
  return [...collections].sort((a, b) => byName.compare(a.name, b.name))
}
