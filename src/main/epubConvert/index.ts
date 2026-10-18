/**
 * EPUB → KF8 book model. Reads an EPUB and produces the `Kf8BookInput` the
 * native writer (`../kf8`) serializes — the calibre-free conversion path.
 *
 * Everything in the archive is untrusted: entry sizes are capped, paths that
 * escape the archive are ignored, scripts/handlers are stripped, images are
 * identified by their bytes, and DRM-encrypted books are refused up front.
 */
import { createHash } from 'crypto'
import type { Kf8BookInput, Kf8TocEntry } from '../kf8'
import { titleFromFilename } from '../titleFromFilename'
import { DEFAULT_ARCHIVE_LIMITS, openArchive, type ArchiveLimits, type EpubArchive } from './archive'
import { decodeDocument } from './dom'
import { assertNotDrmProtected } from './drm'
import { EpubInvalidError, throwIfAborted } from './errors'
import { transformDocument, type TransformedDocument } from './html'
import { sniffImageMime } from './images'
import { readPackage, type EpubPackage, type ManifestItem } from './opf'
import { createRegistry, type BookRegistry, type LoadedImage } from './registry'
import { readToc, type RawTocEntry } from './toc'

export interface EpubToKf8Options {
  /** Identifier stamped into the book (EXTH 113); also names the device thumbnail. */
  asin: string
  /** The app's title/author override whatever the EPUB declares. */
  title?: string
  author?: string
  /** Preferred cover image bytes (e.g. the app's cached cover). */
  cover?: Buffer
  /** Produces the small thumbnail embedded next to the cover. */
  thumbnail?: (cover: Buffer) => Buffer | undefined
  signal?: AbortSignal
  /** Integer percent, monotonically increasing, ending at 100. */
  onProgress?: (percent: number) => void
  limits?: Partial<ArchiveLimits>
  created?: Date
}

/** Progress reserved for transforming documents; the rest is TOC + assembly. */
const DOCUMENTS_PROGRESS_SHARE = 95

async function loadImages(archive: EpubArchive, manifest: ManifestItem[]): Promise<Map<string, LoadedImage>> {
  const images = new Map<string, LoadedImage>()
  for (const item of manifest) {
    if (!item.mediaType.startsWith('image/') || !archive.has(item.path)) continue
    const data = await archive.read(item.path)
    const mime = sniffImageMime(data)
    if (mime) images.set(item.path, { data, mime })
  }
  return images
}

async function loadStylesheets(archive: EpubArchive, manifest: ManifestItem[]): Promise<Map<string, string>> {
  const sheets = new Map<string, string>()
  for (const item of manifest) {
    if (item.mediaType !== 'text/css' || !archive.has(item.path)) continue
    sheets.set(item.path, new TextDecoder('utf-8').decode(await archive.read(item.path)))
  }
  return sheets
}

async function transformSpine(
  archive: EpubArchive,
  spine: ManifestItem[],
  registry: BookRegistry,
  options: EpubToKf8Options
): Promise<TransformedDocument[]> {
  const docs: TransformedDocument[] = []
  for (const [i, item] of spine.entries()) {
    throwIfAborted(options.signal)
    const source = decodeDocument(await archive.read(item.path))
    docs.push(
      transformDocument(source, {
        path: item.path,
        imageUri: registry.imageUri,
        linkUri: registry.linkUri,
        stylesheetFlow: registry.stylesheetFlow,
        inlineStyleFlow: (css) => registry.inlineStyleFlow(css, item.path),
        styleAttribute: (css) => registry.styleAttribute(css, item.path)
      })
    )
    options.onProgress?.(Math.floor(((i + 1) / spine.length) * DOCUMENTS_PROGRESS_SHARE))
  }
  return docs
}

function locateToc(
  raw: RawTocEntry[],
  partIndexByPath: ReadonlyMap<string, number>,
  docs: TransformedDocument[]
): Kf8TocEntry[] {
  return raw.flatMap((e) => {
    const part = partIndexByPath.get(e.path)
    if (part === undefined) return []
    return [{ title: e.title, part, offset: e.fragment ? (docs[part].anchors.get(e.fragment) ?? 0) : 0 }]
  })
}

/** The app's cover when it is a usable image, else the EPUB's own; plus its thumbnail. */
function chooseCover(registry: BookRegistry, pkg: EpubPackage, options: EpubToKf8Options): Kf8BookInput['cover'] {
  const supplied = options.cover ? registry.addImage(options.cover) : undefined
  const image = supplied ?? (pkg.coverPath ? registry.imageIndex(pkg.coverPath) : undefined)
  if (image === undefined) return undefined
  const thumbnail = options.thumbnail?.(registry.images()[image])
  return thumbnail && thumbnail.length > 0 ? { image, thumbnail } : { image }
}

async function buildBook(archive: EpubArchive, filePath: string, options: EpubToKf8Options): Promise<Kf8BookInput> {
  await assertNotDrmProtected(archive)
  const pkg = await readPackage(archive)
  const spine = pkg.spine.filter((item) => archive.has(item.path))
  if (spine.length === 0) throw new EpubInvalidError('The EPUB has no readable content documents')

  const partIndexByPath = new Map(spine.map((item, i) => [item.path, i]))
  const registry = createRegistry(
    await loadImages(archive, pkg.manifest),
    await loadStylesheets(archive, pkg.manifest),
    partIndexByPath
  )
  const docs = await transformSpine(archive, spine, registry, options)
  const anchors = docs.map((d) => d.anchors)
  const toc = locateToc(await readToc(archive, pkg), partIndexByPath, docs)
  const cover = chooseCover(registry, pkg, options)

  const title = options.title?.trim() || pkg.title || titleFromFilename(filePath)
  const author = options.author?.trim()
  return {
    title,
    authors: author ? [author] : pkg.authors,
    ...(pkg.language ? { language: pkg.language } : {}),
    asin: options.asin,
    uniqueId: createHash('sha256').update(options.asin).digest().readUInt32BE(0),
    created: options.created ?? new Date(),
    parts: docs.map((d) => ({
      title: d.title ?? title,
      stylesheets: d.stylesheets,
      htmlAttributes: d.htmlAttributes,
      bodyAttributes: d.bodyAttributes,
      body: registry.resolveLinks(d.body, anchors)
    })),
    stylesheets: registry.stylesheets(),
    images: registry.images(),
    ...(cover ? { cover } : {}),
    toc
  }
}

/** Reads the EPUB at `filePath` into the KF8 writer's book model. */
export async function epubToKf8(filePath: string, options: EpubToKf8Options): Promise<Kf8BookInput> {
  throwIfAborted(options.signal)
  const archive = await openArchive(filePath, { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits })
  try {
    const book = await buildBook(archive, filePath, options)
    options.onProgress?.(100)
    return book
  } finally {
    await archive.close()
  }
}
