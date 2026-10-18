import * as fs from 'fs-extra'
import path from 'path'
import { removeCalibreEntries } from './calibre'
import { SUPPORTED_EXTENSIONS } from './kindle'
import { getThumbnailDir, thumbnailFilename } from './kindleThumbnails'
import { readMobiIdentifiers, type MobiIdentifiers } from './mobiHeader'
import { toDeviceRelpath } from './paths'

export interface DeleteResult {
  /** Book paths that are gone. */
  deleted: string[]
  /** Book paths left in place: refused, missing or not removable. */
  failed: string[]
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The book's path under `documents/` when `bookPath` is a book file there,
 * else undefined. The path comes from the renderer, so it is never trusted:
 * anything outside `documents/`, any other file type and any symbolic link
 * (which could point off the device) is refused.
 */
async function deletableRelpath(mountpoint: string, bookPath: string): Promise<string | undefined> {
  const relpath = toDeviceRelpath(bookPath, mountpoint)
  const extension = path.extname(bookPath).toLowerCase()
  if (relpath === undefined || !SUPPORTED_EXTENSIONS.includes(extension)) return undefined
  const stats = await fs.lstat(bookPath)
  return stats.isFile() ? relpath : undefined
}

/**
 * What the firmware keeps beside a book: the `<name>.sdr` folder (reading
 * position, highlights) and the home-screen thumbnail. Best-effort — the book
 * is already gone, so a leftover is logged rather than reported as a failure.
 */
async function removeSidecars(mountpoint: string, bookPath: string, identifiers: MobiIdentifiers | null): Promise<void> {
  const sidecarDir = path.join(path.dirname(bookPath), `${path.parse(bookPath).name}.sdr`)
  const thumbnails = identifiers ? [path.join(getThumbnailDir(mountpoint), thumbnailFilename(identifiers))] : []
  for (const leftover of [sidecarDir, ...thumbnails]) {
    await fs.remove(leftover).catch((err: unknown) => {
      console.error(`[delete] Could not remove ${leftover}:`, errorText(err))
    })
  }
}

/** Deletes one book; resolves its relpath under `documents/`, or undefined when it was not deleted. */
async function deleteOne(mountpoint: string, bookPath: string): Promise<string | undefined> {
  const relpath = await deletableRelpath(mountpoint, bookPath)
  if (relpath === undefined) {
    console.error(`[delete] Refusing to delete ${bookPath}: not a book file under documents/`)
    return undefined
  }
  // Read before the file goes: the identifiers name the thumbnail.
  const identifiers = await readMobiIdentifiers(bookPath)
  await fs.unlink(bookPath)
  await removeSidecars(mountpoint, bookPath, identifiers)
  return relpath
}

/**
 * Deletes books from the Kindle with everything the device keeps about them:
 * the `.sdr` folder, the thumbnail and the `metadata.calibre` record. Each
 * book is independent — one that cannot be deleted does not stop the rest.
 */
export async function deleteDeviceBooks(mountpoint: string, bookPaths: readonly string[]): Promise<DeleteResult> {
  const outcomes: Array<{ bookPath: string; relpath?: string }> = []
  for (const bookPath of bookPaths) {
    const relpath = await deleteOne(mountpoint, bookPath).catch((err: unknown) => {
      console.error(`[delete] Could not delete ${bookPath}:`, errorText(err))
      return undefined
    })
    outcomes.push({ bookPath, relpath })
  }

  const deletedRelpaths = outcomes.flatMap((o) => (o.relpath === undefined ? [] : [o.relpath]))
  if (deletedRelpaths.length > 0 && !removeCalibreEntries(mountpoint, deletedRelpaths)) {
    console.error('[delete] metadata.calibre is not readable; the deleted books keep their records')
  }
  return {
    deleted: outcomes.filter((o) => o.relpath !== undefined).map((o) => o.bookPath),
    failed: outcomes.filter((o) => o.relpath === undefined).map((o) => o.bookPath)
  }
}
