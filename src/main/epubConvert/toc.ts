import { app } from 'electron'
import { isTag, type Element } from 'domhandler'
import { MAX_PACKAGE_DOCUMENT_BYTES, type EpubArchive } from './archive'
import { decodeDocument, findAllByName, findFirstByName, localName, normalizedText, parseHtml, parseXml } from './dom'
import type { EpubPackage } from './opf'
import { resolveHref } from './paths'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/**
 * Entries kept from a book's table of contents. Real books list a few hundred
 * at most; every entry costs an index record and a navigation lookup.
 */
const MAX_TOC_ENTRIES = 10_000

/** A flattened TOC entry pointing into the archive. */
export interface RawTocEntry {
  title: string
  path: string
  fragment?: string
}

function entry(title: string, basePath: string, href: string | undefined): RawTocEntry[] {
  const target = href ? resolveHref(basePath, href) : undefined
  return title && target ? [{ title, ...target }] : []
}

/** EPUB3: every link of the `epub:type="toc"` nav (or the first nav), in document order. */
function fromNav(source: string, navPath: string): RawTocEntry[] {
  const navs = findAllByName(parseHtml(source), 'nav')
  const toc = navs.find((n) => (n.attribs['epub:type'] ?? '').split(/\s+/).includes('toc')) ?? navs[0]
  if (!toc) return []
  return findAllByName(toc, 'a').flatMap((a) => entry(normalizedText(a), navPath, a.attribs.href))
}

function ownChild(parent: Element, name: string): Element | undefined {
  return parent.children.find((c): c is Element => isTag(c) && localName(c.name) === name)
}

/** EPUB2: every navPoint, depth-first, which is reading order. */
function fromNcx(source: string, ncxPath: string): RawTocEntry[] {
  return findAllByName(parseXml(source), 'navpoint').flatMap((point) => {
    const label = ownChild(point, 'navlabel')
    const textEl = label ? findFirstByName(label, 'text') : undefined
    return entry(textEl ? normalizedText(textEl) : '', ncxPath, ownChild(point, 'content')?.attribs.src)
  })
}

/**
 * The book's table of contents, flattened. A missing or unreadable TOC is not
 * fatal: the writer derives one from the parts instead.
 */
export async function readToc(archive: EpubArchive, pkg: EpubPackage): Promise<RawTocEntry[]> {
  const entries = await readFullToc(archive, pkg)
  if (entries.length > MAX_TOC_ENTRIES) {
    debug(`[epubConvert] TOC has ${entries.length} entries; keeping the first ${MAX_TOC_ENTRIES}`)
  }
  return entries.slice(0, MAX_TOC_ENTRIES)
}

async function readFullToc(archive: EpubArchive, pkg: EpubPackage): Promise<RawTocEntry[]> {
  try {
    if (pkg.navPath && archive.has(pkg.navPath)) {
      const nav = fromNav(decodeDocument(await archive.read(pkg.navPath, MAX_PACKAGE_DOCUMENT_BYTES)), pkg.navPath)
      if (nav.length > 0) return nav
    }
    if (pkg.ncxPath && archive.has(pkg.ncxPath)) {
      return fromNcx(decodeDocument(await archive.read(pkg.ncxPath, MAX_PACKAGE_DOCUMENT_BYTES)), pkg.ncxPath)
    }
  } catch (err) {
    debug('[epubConvert] TOC not readable, deriving one:', err instanceof Error ? err.message : String(err))
  }
  return []
}
