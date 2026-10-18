import { promises as fsp, constants as fsConstants, type Dirent } from 'fs'
import path from 'path'
import { SUPPORTED_EXTENSIONS } from './kindle'

/**
 * Reading a library folder — a folder on this computer whose books the library
 * shows in place. Everything in it is the user's: this module only reads.
 */

/** Deepest subfolder level a scan descends to. A deeper folder makes the scan incomplete. */
export const MAX_SCAN_DEPTH = 16
/** Most books one folder may hold. Past it the scan stops and is marked incomplete. */
export const MAX_SCAN_FILES = 20_000

export interface ScannedFile {
  path: string
  size: number
  /** Whole epoch ms, as stored in library.db. */
  mtimeMs: number
}

export interface FolderScan {
  files: ScannedFile[]
  /**
   * False when part of the folder could not be read (a locked subfolder) or the
   * file limit was hit. A book missing from an incomplete scan may still be
   * there, so nothing may be removed on its strength.
   */
  complete: boolean
}

export interface ScanLimits {
  maxDepth: number
  maxFiles: number
}

const DEFAULT_LIMITS: ScanLimits = { maxDepth: MAX_SCAN_DEPTH, maxFiles: MAX_SCAN_FILES }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True when `child` is `parent` or anywhere below it. Pure path arithmetic: resolve symlinks first. */
export function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A folder that exists and can be listed. An unplugged disk or a refused permission is not one. */
export async function isReadableDirectory(dir: string): Promise<boolean> {
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return false
    await fsp.access(dir, fsConstants.R_OK | fsConstants.X_OK)
    return true
  } catch {
    // ENOENT / EACCES are the answer, not a failure.
    return false
  }
}

/**
 * True for a regular file (not a symlink) whose real path is inside `folder`'s
 * real path. Checked right before a folder book is read, because the file may
 * have been swapped since the last scan.
 */
export async function isRegularFileInside(folder: string, file: string): Promise<boolean> {
  try {
    if (!(await fsp.lstat(file)).isFile()) return false
    // The native realpath also resolves symlinked parent folders and the real
    // letter case, so a renamed "../" route cannot sneak out of the folder.
    const [realFolder, realFile] = await Promise.all([fsp.realpath(folder), fsp.realpath(file)])
    return realFile !== realFolder && isSameOrInside(realFolder, realFile)
  } catch {
    // A file that vanished is simply not inside any more.
    return false
  }
}

function isBookFile(entry: Dirent): boolean {
  return entry.isFile() && SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
}

/**
 * Lists every book file under `root`, subfolders included. Hidden entries are
 * skipped, and symbolic links are never followed (a Dirent's type comes from
 * lstat, so a link is neither a file nor a folder here): a link could lead out
 * of the folder, or in a circle.
 *
 * Returns null when `root` itself cannot be read — the caller must then keep
 * every book, since an unplugged disk looks exactly like an emptied folder.
 */
export async function scanLibraryFolder(root: string, limits: ScanLimits = DEFAULT_LIMITS): Promise<FolderScan | null> {
  if (!(await isReadableDirectory(root))) return null

  const files: ScannedFile[] = []
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let complete = true

  while (pending.length > 0) {
    const { dir, depth } = pending.pop()!
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      console.warn(`[library-folders] Cannot read "${dir}":`, errorText(err))
      complete = false
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (depth < limits.maxDepth) {
          pending.push({ dir: entryPath, depth: depth + 1 })
        } else {
          // Books moved below the limit would look deleted.
          complete = false
        }
        continue
      }
      if (!isBookFile(entry)) continue
      if (files.length >= limits.maxFiles) return { files, complete: false }

      try {
        const stats = await fsp.stat(entryPath)
        files.push({ path: entryPath, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) })
      } catch (err) {
        console.warn(`[library-folders] Cannot read "${entryPath}":`, errorText(err))
        complete = false
      }
    }
  }

  return { files, complete }
}
