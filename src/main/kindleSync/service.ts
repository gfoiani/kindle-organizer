import { AppError } from '../appErrors'
import { readDocuments } from '../kindle'
import { ensureCollectionsContain, getCollectionBooks, getCollections } from '../localCollections'
import { readDeviceExportFile, readDeviceStatusFile, writeDesiredState } from './deviceFiles'
import { getFirstSyncAnswer, recordFirstSyncAnswer, type FirstSyncAnswer } from './firstSyncAnswers'
import { planKindleImport } from './importPlan'
import { detectJailbreak } from './jailbreak'
import { planKindleCollections, type AppCollectionMembers } from './plan'
import type { DeviceExport, DeviceStatus, SyncMode } from './syncFiles'

/**
 * The app side of the collection sync with a jailbroken Kindle: what the UI
 * shows for a connected Kindle, the desired state written to it, and the
 * first-sync answer. Callers have already checked the mountpoint is a
 * connected Kindle (`requireKindleDrive`).
 */

export interface KindleCollectionSummary {
  name: string
  /** Every member, including the ones the app cannot see (Amazon/cloud items). */
  bookCount: number
}

export type KindleSyncState =
  | { kind: 'not-jailbroken' }
  | { kind: 'unsupported-jailbreak' }
  | { kind: 'not-installed' }
  /** `kindleCollections` is null when the device's export cannot be read. */
  | { kind: 'first-sync'; status: DeviceStatus; kindleCollections: KindleCollectionSummary[] | null }
  | { kind: 'active'; status: DeviceStatus }

type Probe = { kind: 'blocked'; state: KindleSyncState } | { kind: 'installed'; status: DeviceStatus }

/** Whether the sync can run on this Kindle: a jb.sh jailbreak and a component that has reported once. */
async function probe(mountpoint: string): Promise<Probe> {
  const jailbreak = await detectJailbreak(mountpoint)
  if (jailbreak.kind === 'none') return { kind: 'blocked', state: { kind: 'not-jailbroken' } }
  if (jailbreak.kind === 'unsupported') return { kind: 'blocked', state: { kind: 'unsupported-jailbreak' } }
  const status = await readDeviceStatusFile(mountpoint)
  if (status === null) return { kind: 'blocked', state: { kind: 'not-installed' } }
  return { kind: 'installed', status }
}

async function deviceRelpaths(mountpoint: string): Promise<string[]> {
  return (await readDocuments(mountpoint)).flatMap((book) => book.relpath ?? [])
}

function appCollectionMembers(): AppCollectionMembers[] {
  return getCollections().map((collection) => ({ name: collection.name, relpaths: getCollectionBooks(collection.id) }))
}

async function writeDesired(mountpoint: string, mode: SyncMode): Promise<void> {
  const plan = planKindleCollections(appCollectionMembers(), await deviceRelpaths(mountpoint))
  await writeDesiredState(mountpoint, plan, mode)
}

function summarize(exported: DeviceExport | null): KindleCollectionSummary[] | null {
  if (exported === null) return null
  return exported.collections.map((collection) => ({
    name: collection.name,
    bookCount: collection.members.length + collection.otherMembers
  }))
}

/**
 * The sync state of a connected Kindle. On a Kindle with the component it also
 * writes the app's collections for the next unplug: held until the first-sync
 * question is answered, mirrored afterwards. Nothing is written otherwise.
 */
export async function refreshKindleSync(mountpoint: string): Promise<KindleSyncState> {
  const probed = await probe(mountpoint)
  if (probed.kind === 'blocked') return probed.state
  const { status } = probed

  const answered = getFirstSyncAnswer(status.deviceId) !== null
  await writeDesired(mountpoint, answered ? 'mirror' : 'hold')
  if (answered) return { kind: 'active', status }
  return { kind: 'first-sync', status, kindleCollections: summarize(await readDeviceExportFile(mountpoint)) }
}

/**
 * Records the first-sync answer; `import` first turns the Kindle's collections
 * into app collections. Nothing is recorded when the import cannot run, so the
 * question is asked again rather than the Kindle's collections being lost.
 */
export async function answerFirstSync(mountpoint: string, answer: FirstSyncAnswer): Promise<KindleSyncState> {
  const probed = await probe(mountpoint)
  if (probed.kind === 'blocked') throw new AppError('KINDLE_SYNC_NOT_INSTALLED')

  if (answer === 'import') {
    const exported = await readDeviceExportFile(mountpoint)
    if (exported === null) throw new AppError('KINDLE_SYNC_EXPORT_UNREADABLE')
    const existingNames = getCollections().map((collection) => collection.name)
    ensureCollectionsContain(planKindleImport(exported, await deviceRelpaths(mountpoint), existingNames))
  }

  recordFirstSyncAnswer(probed.status.deviceId, answer)
  return refreshKindleSync(mountpoint)
}

/**
 * Whether connecting this Kindle must no longer import its calibre tags: once
 * its first-sync question is answered, the app is the source of truth and a
 * re-import would bring back collections the user removed. A Kindle without
 * the sync (no jailbreak, no component) keeps importing them.
 */
export async function isCalibreImportRetired(mountpoint: string): Promise<boolean> {
  const probed = await probe(mountpoint)
  return probed.kind === 'installed' && getFirstSyncAnswer(probed.status.deviceId) !== null
}
