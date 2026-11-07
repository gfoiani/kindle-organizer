import { promises as fs } from 'fs'
import path from 'path'
import { writeFileAtomically } from '../atomicWrite'
import type { PlannedKindleCollection } from './plan'
import {
  desiredReadyMarker,
  parseDeviceExport,
  parseDeviceStatus,
  serializeDesired,
  type DeviceExport,
  type DeviceStatus,
  type SyncMode
} from './syncFiles'

/**
 * Reads and writes the collection-sync files on the Kindle's USB partition
 * (`<mountpoint>/kindle-organizer/`, which the device sees as
 * `/mnt/us/kindle-organizer/`). Formats live in `syncFiles.ts`.
 */

export const SYNC_DIR = 'kindle-organizer'
const DESIRED_FILE = 'desired.json'
const READY_FILE = 'desired.ready'
const STATUS_FILE = 'status.json'
const EXPORT_FILE = 'export.json'
/** Larger than any real export (5000 collections × long names); bigger files are refused unread. */
const MAX_DEVICE_FILE_BYTES = 16 * 1024 * 1024

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The sync folder, created when missing; a link (or a file) in its place is refused. */
async function ensureSyncDir(mountpoint: string): Promise<string> {
  const dir = path.join(mountpoint, SYNC_DIR)
  await fs.mkdir(dir, { recursive: true })
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory()) throw new Error(`${dir} is not a plain folder`)
  return dir
}

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  }
}

/**
 * Writes the desired collections, then the ready marker (its sha256) last, so
 * the device never applies a half-written file. Identical state already on the
 * device is not rewritten.
 */
export async function writeDesiredState(
  mountpoint: string,
  plan: readonly PlannedKindleCollection[],
  mode: SyncMode
): Promise<'written' | 'unchanged'> {
  const dir = await ensureSyncDir(mountpoint)
  const desired = serializeDesired(plan, mode)
  const marker = desiredReadyMarker(desired)

  const [currentDesired, currentMarker] = await Promise.all([
    readTextIfPresent(path.join(dir, DESIRED_FILE)),
    readTextIfPresent(path.join(dir, READY_FILE))
  ])
  if (currentDesired === desired && currentMarker === marker) return 'unchanged'

  await writeFileAtomically(path.join(dir, DESIRED_FILE), desired)
  await writeFileAtomically(path.join(dir, READY_FILE), marker)
  return 'written'
}

/**
 * The parsed JSON of a file the device wrote, or null when it is missing,
 * a link, oversized or not JSON. Problems other than "missing" are logged.
 */
async function readDeviceJson(mountpoint: string, name: string): Promise<unknown> {
  const file = path.join(mountpoint, SYNC_DIR, name)
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > MAX_DEVICE_FILE_BYTES) {
      console.warn(`[kindleSync] ignoring ${file}: not a plain file or larger than ${MAX_DEVICE_FILE_BYTES} bytes`)
      return null
    }
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (!isMissing(err)) console.warn(`[kindleSync] cannot read ${file}:`, errorText(err))
    return null
  }
}

function logIfInvalid<T>(name: string, raw: unknown, parsed: T | null): T | null {
  if (raw !== null && parsed === null) console.warn(`[kindleSync] ${name} on the Kindle does not match the expected format`)
  return parsed
}

export async function readDeviceStatusFile(mountpoint: string): Promise<DeviceStatus | null> {
  const raw = await readDeviceJson(mountpoint, STATUS_FILE)
  return logIfInvalid(STATUS_FILE, raw, raw === null ? null : parseDeviceStatus(raw))
}

export async function readDeviceExportFile(mountpoint: string): Promise<DeviceExport | null> {
  const raw = await readDeviceJson(mountpoint, EXPORT_FILE)
  return logIfInvalid(EXPORT_FILE, raw, raw === null ? null : parseDeviceExport(raw))
}
