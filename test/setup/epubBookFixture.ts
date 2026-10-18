import { writeFileSync } from 'fs'
import { buildStoredZip } from './epubFixture'

/**
 * Builds a complete EPUB (content documents, stylesheets, images, nav/NCX) for
 * the converter tests. Paths are relative to the OPF directory (`OEBPS/`).
 */

export interface EpubBookSpec {
  title?: string
  author?: string
  language?: string
  /** Spine documents, in reading order. `body` is the XHTML inside <body>. */
  docs: Array<{
    path: string
    body: string
    head?: string
    title?: string
    bodyAttrs?: string
    linear?: boolean
    /** Exact bytes of the document, bypassing the XHTML template (encodings, malformed files). */
    raw?: Buffer
  }>
  stylesheets?: Array<{ path: string; css: string }>
  images?: Array<{ path: string; data: Buffer; mediaType?: string; cover?: boolean }>
  /** EPUB3 navigation document body (inside <nav epub:type="toc">). */
  nav?: string
  /** EPUB2 NCX navMap contents. */
  ncx?: string
  /** Raw META-INF/encryption.xml. */
  encryption?: string
  /** Extra raw zip entries (full archive paths). */
  extraEntries?: Array<{ name: string; data: Buffer }>
  /** Spine order as doc paths, when it is not simply `docs` (repeats, omissions). */
  spine?: string[]
}

const ROOT = 'OEBPS'

export function xhtml(body: string, head = '', title = 'Doc', bodyAttrs = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="it">
<head><title>${title}</title>${head}</head>
<body${bodyAttrs}>${body}</body>
</html>`
}

function mediaTypeFor(path: string): string {
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function buildOpf(spec: EpubBookSpec): string {
  const items = [
    ...spec.docs.map((d, i) => `<item id="doc${i}" href="${d.path}" media-type="application/xhtml+xml"/>`),
    ...(spec.stylesheets ?? []).map((s, i) => `<item id="css${i}" href="${s.path}" media-type="text/css"/>`),
    ...(spec.images ?? []).map(
      (img, i) =>
        `<item id="img${i}" href="${img.path}" media-type="${img.mediaType ?? mediaTypeFor(img.path)}"${img.cover ? ' properties="cover-image"' : ''}/>`
    ),
    ...(spec.nav !== undefined ? ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'] : []),
    ...(spec.ncx !== undefined ? ['<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'] : [])
  ]
  const spine = spec.spine
    ? spec.spine.map((p) => `<itemref idref="doc${spec.docs.findIndex((d) => d.path === p)}"/>`).join('')
    : spec.docs.map((d, i) => `<itemref idref="doc${i}"${d.linear === false ? ' linear="no"' : ''}/>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:fixture</dc:identifier>
<dc:title>${spec.title ?? 'Fixture Book'}</dc:title>
${spec.author ? `<dc:creator>${spec.author}</dc:creator>` : ''}
${spec.language ? `<dc:language>${spec.language}</dc:language>` : ''}
</metadata>
<manifest>${items.join('\n')}</manifest>
<spine${spec.ncx !== undefined ? ' toc="ncx"' : ''}>${spine}</spine>
</package>`
}

export function buildEpubBook(spec: EpubBookSpec): Buffer {
  const entry = (name: string, data: string | Buffer): { name: string; data: Buffer } => ({
    name,
    data: typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  })
  const entries = [
    entry('mimetype', 'application/epub+zip'),
    entry(
      'META-INF/container.xml',
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${ROOT}/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    ),
    entry(`${ROOT}/content.opf`, buildOpf(spec)),
    ...spec.docs.map((d) => entry(`${ROOT}/${d.path}`, d.raw ?? xhtml(d.body, d.head, d.title, d.bodyAttrs))),
    ...(spec.stylesheets ?? []).map((s) => entry(`${ROOT}/${s.path}`, s.css)),
    ...(spec.images ?? []).map((img) => entry(`${ROOT}/${img.path}`, img.data)),
    ...(spec.nav !== undefined
      ? [entry(`${ROOT}/nav.xhtml`, xhtml(`<nav epub:type="toc"><ol>${spec.nav}</ol></nav>`))]
      : []),
    ...(spec.ncx !== undefined
      ? [
          entry(
            `${ROOT}/toc.ncx`,
            `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>T</text></docTitle><navMap>${spec.ncx}</navMap></ncx>`
          )
        ]
      : []),
    ...(spec.encryption !== undefined ? [entry('META-INF/encryption.xml', spec.encryption)] : []),
    ...(spec.extraEntries ?? [])
  ]
  return buildStoredZip(entries)
}

export function writeEpubBook(filePath: string, spec: EpubBookSpec): string {
  writeFileSync(filePath, buildEpubBook(spec))
  return filePath
}

/** Real magic bytes so the converter's sniffing accepts (or rejects) them. */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 8)])
export const WEBP = Buffer.concat([Buffer.from('RIFF0000WEBP', 'latin1'), Buffer.alloc(64, 9)])
