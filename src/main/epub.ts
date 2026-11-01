import { app } from 'electron'
import path from 'path'
import { XMLParser } from 'fast-xml-parser'
import { titleFromFilename } from './titleFromFilename'
import { capLength, MAX_METADATA_TEXT } from './textLimits'
import { openArchive, type ArchiveLimits, type EpubArchive } from './epubConvert/archive'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

export interface EpubMetadata {
  title: string
  author?: string
  /** Raw bytes of the embedded cover image, when present. */
  coverImage?: Buffer
}

const CONTAINER_PATH = 'META-INF/container.xml'

/**
 * Only container.xml, the OPF and the cover are read, and a real book keeps all
 * three far below these sizes. The archive is untrusted — a file merely
 * dropped into a library folder is parsed — so the caps are enforced on the
 * bytes actually inflated (see epubConvert/archive.ts), not on declared sizes.
 */
export const EPUB_METADATA_LIMITS: ArchiveLimits = {
  maxEntryBytes: 16 * 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024
}

// Namespace prefixes are dropped (as in epubConvert/opf.ts): Dublin Core is
// just as often a default namespace (`<creator xmlns="…dc…">`) as `dc:creator`.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true })

/**
 * Reads title/author and (when present) the embedded cover from an EPUB without
 * inflating the whole archive — only container.xml, the OPF, and the cover entry
 * are read.
 *
 * Failure policy: a corrupt/unreadable ZIP is fatal (throws). Everything softer —
 * a missing container, a malformed OPF, an absent or unreadable cover — degrades
 * to a usable result (title from the filename, no cover) rather than throwing, so
 * a quirky-but-openable EPUB can still be added to the library.
 */
export async function parseEpub(filePath: string, limits: ArchiveLimits = EPUB_METADATA_LIMITS): Promise<EpubMetadata> {
  const fallbackTitle = titleFromFilename(filePath)

  // A non-ZIP / corrupt archive throws here.
  let archive: EpubArchive
  try {
    archive = await openArchive(filePath, limits)
  } catch (err) {
    throw new Error(`Cannot read EPUB archive "${filePath}": ${errorText(err)}`)
  }

  try {
    const opfPath = await readOpfPath(archive, limits)
    if (!opfPath) return { title: fallbackTitle }

    const opfXml = (await archive.read(opfPath, limits.maxDocumentBytes)).toString('utf-8')
    const opf = parseOpf(opfXml)
    const coverImage = await readCoverImage(archive, opfPath, opf.coverHref)

    return {
      title: opf.title ?? fallbackTitle,
      ...(opf.author ? { author: opf.author } : {}),
      ...(coverImage ? { coverImage } : {})
    }
  } catch (err) {
    // Openable archive but unreadable (or oversized) metadata — degrade instead of failing.
    debug(`[epub] Degraded parse of "${filePath}":`, errorText(err))
    return { title: fallbackTitle }
  } finally {
    await archive.close()
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Reads the OPF path from META-INF/container.xml (first rootfile). */
async function readOpfPath(archive: EpubArchive, limits: ArchiveLimits): Promise<string | undefined> {
  const xml = (await archive.read(CONTAINER_PATH, limits.maxDocumentBytes)).toString('utf-8')
  const doc = parser.parse(xml)
  const rootfile = firstOf(doc?.container?.rootfiles?.rootfile)
  const fullPath = rootfile?.['@_full-path']
  return typeof fullPath === 'string' ? fullPath : undefined
}

interface OpfData {
  title?: string
  author?: string
  coverHref?: string
}

function parseOpf(opfXml: string): OpfData {
  const doc = parser.parse(opfXml)
  const pkg = doc?.package
  const metadata = pkg?.metadata
  const manifest = pkg?.manifest

  return {
    title: firstText(metadata?.title),
    author: firstText(metadata?.creator),
    coverHref: findCoverHref(metadata, manifest)
  }
}

/** Locates the cover image href via EPUB3 properties, then EPUB2 meta, then a heuristic. */
function findCoverHref(metadata: unknown, manifest: unknown): string | undefined {
  const items = toArray((manifest as Record<string, unknown> | undefined)?.item)

  // EPUB3: manifest item with properties containing "cover-image".
  for (const item of items) {
    const props = item?.['@_properties']
    if (typeof props === 'string' && props.split(/\s+/).includes('cover-image')) {
      const href = item?.['@_href']
      if (typeof href === 'string') return href
    }
  }

  // EPUB2: <meta name="cover" content="<item-id>"> → matching manifest item.
  const metas = toArray((metadata as Record<string, unknown> | undefined)?.meta)
  const coverId = metas.find((m) => m?.['@_name'] === 'cover')?.['@_content']
  if (typeof coverId === 'string') {
    const href = items.find((it) => it?.['@_id'] === coverId)?.['@_href']
    if (typeof href === 'string') return href
  }

  // Heuristic: an image item whose id looks like a cover.
  const guess = items.find((it) => {
    const id = String(it?.['@_id'] ?? '').toLowerCase()
    const type = String(it?.['@_media-type'] ?? '')
    return type.startsWith('image/') && id.includes('cover')
  })
  const href = guess?.['@_href']
  return typeof href === 'string' ? href : undefined
}

/** Reads the cover entry, resolving its href relative to the OPF's directory. */
async function readCoverImage(
  archive: EpubArchive,
  opfPath: string,
  coverHref: string | undefined
): Promise<Buffer | undefined> {
  if (!coverHref) return undefined

  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, '/'))
  const decoded = decodeURIComponent(coverHref)
  const entryPath = opfDir === '.' ? decoded : path.posix.join(opfDir, decoded)

  try {
    const data = await archive.read(entryPath)
    return data.length > 0 ? data : undefined
  } catch (err) {
    // Missing or past the size cap: the book simply has no embedded cover.
    debug(`[epub] Cover entry "${entryPath}" not readable:`, errorText(err))
    return undefined
  }
}

/** fast-xml-parser yields a single object or an array depending on cardinality. */
function toArray(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
}

function firstOf(value: unknown): Record<string, unknown> | undefined {
  return toArray(value)[0]
}

/** Extracts trimmed text from a dc:* node, cut to MAX_METADATA_TEXT. */
function firstText(node: unknown): string | undefined {
  const text = rawFirstText(node)
  return text === undefined ? undefined : capLength(text, MAX_METADATA_TEXT)
}

/** Extracts trimmed text from a dc:* node (string, number, array, or {#text}). */
function rawFirstText(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined
  const first = Array.isArray(node) ? node[0] : node
  if (typeof first === 'string') return first.trim() || undefined
  if (typeof first === 'number') return String(first)
  if (typeof first === 'object') {
    const text = (first as Record<string, unknown>)['#text']
    if (typeof text === 'string') return text.trim() || undefined
    if (typeof text === 'number') return String(text)
  }
  return undefined
}
