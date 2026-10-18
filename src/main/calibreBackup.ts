import * as fs from 'fs-extra'
import path from 'path'

/**
 * Copies of `metadata.calibre` taken before every overwrite.
 *
 * The write itself is atomic, which protects against an unplug mid-write but
 * not against a logic error: a bad write lands on the device whole. The copies
 * live on the Kindle itself (outside `documents/`, which the firmware indexes),
 * so each device carries its own history and a restore can never pick up
 * another Kindle's file.
 */

const BACKUP_DIR = path.join('.kindle-organizer', 'backups')
/** How many copies are kept; the oldest go first. */
export const CALIBRE_BACKUP_LIMIT = 10
/**
 * A routine write within this long of the last copy takes no new one, so a
 * bulk send (one record per book) keeps the file as it was before the send
 * instead of pushing it out of the CALIBRE_BACKUP_LIMIT window.
 */
const RECENT_BACKUP_MS = 10 * 60 * 1000

/**
 * `metadata.calibre.<ISO time with - for : and .>[-<n>].json`. FAT forbids `:`
 * in names; `n` orders copies taken within the same millisecond.
 */
const BACKUP_NAME = /^metadata\.calibre\.(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z(?:-(\d+))?\.json$/

export interface CalibreBackup {
  file: string
  /** When the copy was taken, as an ISO-8601 UTC timestamp. */
  takenAt: string
  sequence: number
}

export function getBackupDir(mountpoint: string): string {
  return path.join(mountpoint, BACKUP_DIR)
}

function backupName(now: Date, sequence: number): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `metadata.calibre.${stamp}${sequence > 0 ? `-${sequence}` : ''}.json`
}

function parseBackup(dir: string, name: string): CalibreBackup[] {
  const match = BACKUP_NAME.exec(name)
  if (!match) return []
  const [, date, hours, minutes, seconds, millis, sequence] = match
  return [
    {
      file: path.join(dir, name),
      takenAt: `${date}T${hours}:${minutes}:${seconds}.${millis}Z`,
      sequence: Number(sequence ?? 0)
    }
  ]
}

/** The device's backups, newest first. */
export function listCalibreBackups(mountpoint: string): CalibreBackup[] {
  const dir = getBackupDir(mountpoint)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .flatMap((name) => parseBackup(dir, name))
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.sequence - a.sequence)
}

/** What the renderer may see of a backup: its file name (the id a restore asks for) and when it was taken. */
export interface CalibreBackupSummary {
  id: string
  takenAt: string
}

/** The device's backups, newest first, without their paths. */
export function describeCalibreBackups(mountpoint: string): CalibreBackupSummary[] {
  return listCalibreBackups(mountpoint).map((backup) => ({ id: path.basename(backup.file), takenAt: backup.takenAt }))
}

/** Whether the newest copy was taken within RECENT_BACKUP_MS. */
export function hasRecentCalibreBackup(mountpoint: string, now = Date.now()): boolean {
  const [newest] = listCalibreBackups(mountpoint)
  return newest !== undefined && now - Date.parse(newest.takenAt) < RECENT_BACKUP_MS
}

/**
 * Copies the current `metadata.calibre` into the backup folder, then prunes
 * past `CALIBRE_BACKUP_LIMIT`. Throws when the copy cannot be made: the caller
 * must not overwrite a file it could not back up.
 */
export function backupCalibreMetadata(mountpoint: string, metadataPath: string, now = new Date()): void {
  const dir = getBackupDir(mountpoint)
  fs.ensureDirSync(dir)
  const existing = new Set(fs.readdirSync(dir))
  let sequence = 0
  while (existing.has(backupName(now, sequence))) sequence++
  const target = path.join(dir, backupName(now, sequence))
  try {
    fs.copyFileSync(metadataPath, target)
  } catch (err) {
    // A full device can leave a truncated copy behind: it must not pass for a backup.
    fs.removeSync(target)
    throw err
  }

  // The copy exists, so a failed prune only costs space: it must not block the write.
  for (const stale of listCalibreBackups(mountpoint).slice(CALIBRE_BACKUP_LIMIT)) {
    try {
      fs.removeSync(stale.file)
    } catch (err) {
      console.error(`[calibre] Could not prune the old backup ${stale.file}:`, err instanceof Error ? err.message : String(err))
    }
  }
}
