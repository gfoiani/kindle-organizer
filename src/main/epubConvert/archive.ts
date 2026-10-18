import { app } from 'electron'
import StreamZip from 'node-stream-zip'
import { EpubInvalidError } from './errors'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/**
 * Guards against hostile archives (zip bombs): sizes come from the central
 * directory and are re-checked on the inflated data.
 */
export interface ArchiveLimits {
  maxEntryBytes: number
  maxTotalBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 768 * 1024 * 1024
}

export interface EpubArchive {
  has(entryPath: string): boolean
  read(entryPath: string): Promise<Buffer>
  close(): Promise<void>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Opens an EPUB for random access. Entry lookup falls back to a
 * case-insensitive match, since EPUBs made on case-insensitive file systems
 * often disagree with their own manifest about case.
 */
export async function openArchive(filePath: string, limits: ArchiveLimits): Promise<EpubArchive> {
  const zip = new StreamZip.async({ file: filePath })
  let entries: Record<string, StreamZip.ZipEntry>
  try {
    entries = await zip.entries()
  } catch (err) {
    await zip.close().catch((closeErr: unknown) => debug('[epubConvert] close failed:', errorText(closeErr)))
    throw new EpubInvalidError(`Not a readable EPUB archive: ${errorText(err)}`)
  }

  const names = Object.keys(entries)
  const byLowerCase = new Map(names.map((n) => [n.toLowerCase(), n]))
  const resolve = (entryPath: string): string | undefined =>
    entries[entryPath] ? entryPath : byLowerCase.get(entryPath.toLowerCase())
  let totalRead = 0

  const read = async (entryPath: string): Promise<Buffer> => {
    const name = resolve(entryPath)
    if (!name) throw new EpubInvalidError(`Missing archive entry "${entryPath}"`)
    const declared = entries[name].size
    if (declared > limits.maxEntryBytes) throw new EpubInvalidError(`Archive entry "${name}" is too large`)
    totalRead += declared
    if (totalRead > limits.maxTotalBytes) throw new EpubInvalidError('The EPUB expands to too much data')
    const data = await zip.entryData(name)
    if (data.length > limits.maxEntryBytes) throw new EpubInvalidError(`Archive entry "${name}" is too large`)
    return data
  }

  const close = async (): Promise<void> => {
    try {
      await zip.close()
    } catch (err) {
      debug('[epubConvert] Failed to close archive:', errorText(err))
    }
  }

  return { has: (entryPath) => resolve(entryPath) !== undefined, read, close }
}
