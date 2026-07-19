import { crc32 } from 'zlib'
import { writeFileSync } from 'fs'

/**
 * Dependency-free EPUB fixture builder for tests.
 *
 * An EPUB is just a ZIP. `node-stream-zip` reads STORED (uncompressed) entries,
 * so we hand-roll a minimal STORED ZIP (CRC-32 via Node's `zlib.crc32`) instead
 * of pulling in a zip-writer devDependency. This lets tests parametrize the
 * archive (EPUB2 vs EPUB3 cover, missing container, malformed OPF) cheaply.
 */

interface ZipEntry {
  name: string
  data: Buffer
}

/** Builds a minimal STORED (method 0) ZIP archive. */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const crc = crc32(entry.data) >>> 0
    const size = entry.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = STORED
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // compressed size
    local.writeUInt32LE(size, 22) // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localChunks.push(local, nameBuf, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central dir header signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(0, 10) // method
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0, 14) // mod date
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centralChunks.push(central, nameBuf)

    offset += local.length + nameBuf.length + entry.data.length
  }

  const centralBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central dir signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(centralBuf.length, 12) // central dir size
  eocd.writeUInt32LE(offset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localChunks, centralBuf, eocd])
}

/** A fake but magic-valid JPEG large enough to pass covers.isValidImage (≥500 bytes). */
export function fakeJpeg(bytes = 800): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, bytes - 4), 0x20)])
}

export interface EpubFixtureOptions {
  title?: string
  author?: string
  /** Embed this image as the cover. Style controlled by `coverStyle`. */
  cover?: Buffer
  /** 'epub3' → manifest item properties="cover-image"; 'epub2' → <meta name="cover">. */
  coverStyle?: 'epub3' | 'epub2'
  /** Omit META-INF/container.xml (parser should degrade to filename). */
  omitContainer?: boolean
  /** Write a non-XML OPF body (parser should degrade to filename). */
  malformedOpf?: boolean
}

const OPF_PATH = 'OEBPS/content.opf'
const COVER_PATH = 'OEBPS/images/cover.jpg'

function buildOpf(opts: EpubFixtureOptions): string {
  const title = opts.title ?? 'Fixture Title'
  const author = opts.author
  const hasCover = opts.cover !== undefined
  const style = opts.coverStyle ?? 'epub3'

  const meta = [
    `    <dc:title>${title}</dc:title>`,
    author ? `    <dc:creator>${author}</dc:creator>` : '',
    hasCover && style === 'epub2' ? `    <meta name="cover" content="cover-img"/>` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const coverItemProps =
    hasCover && style === 'epub3' ? ' properties="cover-image"' : ''
  const manifestItems = [
    `    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>`,
    hasCover
      ? `    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"${coverItemProps}/>`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta}
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`
}

/** Builds an EPUB archive (Buffer) parametrized by `opts`. */
export function buildEpub(opts: EpubFixtureOptions = {}): Buffer {
  const entries: ZipEntry[] = [{ name: 'mimetype', data: Buffer.from('application/epub+zip') }]

  if (!opts.omitContainer) {
    entries.push({
      name: 'META-INF/container.xml',
      data: Buffer.from(
        `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
      )
    })
  }

  entries.push({
    name: OPF_PATH,
    data: Buffer.from(opts.malformedOpf ? 'this is not <xml' : buildOpf(opts))
  })

  if (opts.cover) {
    entries.push({ name: COVER_PATH, data: opts.cover })
  }

  return buildStoredZip(entries)
}

/** Writes an EPUB fixture to disk and returns the path (node-stream-zip reads files). */
export function writeEpub(filePath: string, opts: EpubFixtureOptions = {}): string {
  writeFileSync(filePath, buildEpub(opts))
  return filePath
}
