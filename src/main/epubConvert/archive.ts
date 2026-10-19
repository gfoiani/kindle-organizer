import { app } from 'electron'
import StreamZip from 'node-stream-zip'
import { EpubInvalidError } from './errors'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/**
 * Guards against hostile archives (zip bombs). The central directory's sizes
 * are attacker-controlled — and node-stream-zip skips its own size check for
 * entries flagged with a data descriptor — so the limits are enforced on the
 * bytes actually inflated, while they stream in.
 */
export interface ArchiveLimits {
  maxEntryBytes: number
  /** Tighter cap for content documents, which are parsed into a DOM (~50-100× their size). */
  maxDocumentBytes: number
  maxTotalBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
}

export interface EpubArchive {
  has(entryPath: string): boolean
  /** Reads an entry, rejecting with EpubInvalidError past `maxBytes` (default: maxEntryBytes). */
  read(entryPath: string, maxBytes?: number): Promise<Buffer>
  close(): Promise<void>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Entry names are attacker-controlled: keep control characters out of the logs. */
function printable(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '?')
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

  const byLowerCase = new Map(Object.keys(entries).map((n) => [n.toLowerCase(), n]))
  const resolve = (entryPath: string): string | undefined =>
    // Own keys only: a manifest href such as "constructor" must not hit Object.prototype.
    Object.prototype.hasOwnProperty.call(entries, entryPath) ? entryPath : byLowerCase.get(entryPath.toLowerCase())
  let totalRead = 0

  const readCapped = async (name: string, maxBytes: number): Promise<Buffer> => {
    const chunks: Buffer[] = []
    let length = 0
    let stream: NodeJS.ReadableStream | undefined
    try {
      stream = await zip.stream(name)
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        length += chunk.length
        totalRead += chunk.length
        if (length > maxBytes) throw new EpubInvalidError(`Archive entry "${printable(name)}" is too large`)
        if (totalRead > limits.maxTotalBytes) throw new EpubInvalidError('The EPUB expands to too much data')
        chunks.push(chunk)
      }
    } catch (err) {
      ;(stream as { destroy?: () => void } | undefined)?.destroy?.()
      if (err instanceof EpubInvalidError) throw err
      throw new EpubInvalidError(`Archive entry "${printable(name)}" is not readable: ${errorText(err)}`)
    }
    return Buffer.concat(chunks, length)
  }

  const read = async (entryPath: string, maxBytes = limits.maxEntryBytes): Promise<Buffer> => {
    const name = resolve(entryPath)
    if (!name) throw new EpubInvalidError(`Missing archive entry "${printable(entryPath)}"`)
    const cap = Math.min(maxBytes, limits.maxEntryBytes)
    if (entries[name].size > cap) throw new EpubInvalidError(`Archive entry "${printable(name)}" is too large`)
    return readCapped(name, cap)
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
