/**
 * Native KF8 (AZW3) writer — what lets the app send EPUBs to a Kindle without
 * calibre installed.
 *
 * The container layout is a TypeScript port of leotaku/mobi (MIT © Leo Gaskin),
 * with the index details (skeleton geometry, index/CNCX record splitting, NCX
 * pos_fid, header sentinels) aligned byte-for-byte with what calibre writes,
 * since calibre's output is what every Kindle has been reading for a decade.
 *
 * One skeleton + one chunk per part: the skeleton is a complete XHTML document
 * with an empty body, and the part's body is inserted right after `<body …>`.
 */
import { NULL_INDEX, toBase32 } from './encoding'
import { EXTH, exthString, exthUint32, type ExthEntry } from './exth'
import { buildIndex, type TagDef } from './indx'
import { buildCncx } from './cncx'
import { baseLanguage, mobiLocale } from './locale'
import { buildPalmDb } from './palmdb'
import { buildRecord0 } from './record0'
import { buildFcis, buildFdst, buildFlis, EOF_RECORD } from './records'
import { buildSkeleton } from './skeleton'
import { buildTextRecords } from './text'
import { capLength } from '../textLimits'

export { flowUri as kindleFlowUri } from './skeleton'

export interface Kf8Part {
  title: string
  /** 1-based indexes into `Kf8BookInput.stylesheets`, linked in this order. */
  stylesheets: number[]
  htmlAttributes?: Readonly<Record<string, string>>
  bodyAttributes?: Readonly<Record<string, string>>
  /** Body content (XHTML), links and images already rewritten to kindle: URIs. */
  body: string
}

export interface Kf8TocEntry {
  title: string
  part: number
  /** Byte offset of the target element inside the part's body. */
  offset: number
}

export interface Kf8BookInput {
  title: string
  authors: string[]
  /** BCP 47 tag, e.g. "it" or "en-US". */
  language?: string
  /** Book identifier stored as EXTH 113 — also the ASIN in the device thumbnail name. */
  asin: string
  uniqueId: number
  created: Date
  parts: Kf8Part[]
  stylesheets: string[]
  /** Image resources; `kindleEmbedUri(i)` references `images[i]`. */
  images: Buffer[]
  cover?: { image: number; thumbnail?: Buffer }
  toc: Kf8TocEntry[]
}

/** `kindle:embed` reference to `images[index]` (the URI itself is 1-based). */
export function kindleEmbedUri(index: number, mime: string): string {
  return `kindle:embed:${toBase32(index + 1, 4)}?mime=${mime}`
}

/** `kindle:pos` link to byte `offset` of part `part`'s body. */
export function kindlePosUri(part: number, offset: number): string {
  return `kindle:pos:fid:${toBase32(part, 4)}:off:${toBase32(offset, 10)}`
}

/**
 * Longest part or navigation title written. A CNCX record must stay under
 * 64 KiB and one string cannot be split across records, so an unbounded
 * title (a hostile <title>, a runaway heading) would break the index.
 */
const MAX_TITLE_LENGTH = 256

function capTitle(title: string): string {
  return capLength(title, MAX_TITLE_LENGTH)
}

const SKELETON_TAGS: TagDef[] = [
  { tag: 1, valuesPerEntry: 1, mask: 3 }, // chunk count (written twice)
  { tag: 6, valuesPerEntry: 2, mask: 12 } // geometry (written twice)
]
const CHUNK_TAGS: TagDef[] = [
  { tag: 2, valuesPerEntry: 1, mask: 1 }, // CNCX offset of the selector
  { tag: 3, valuesPerEntry: 1, mask: 2 }, // file number
  { tag: 4, valuesPerEntry: 1, mask: 4 }, // sequence number
  { tag: 6, valuesPerEntry: 2, mask: 8 } // geometry
]
const NCX_TAGS: TagDef[] = [
  { tag: 1, valuesPerEntry: 1, mask: 1 }, // position
  { tag: 2, valuesPerEntry: 1, mask: 2 }, // length
  { tag: 3, valuesPerEntry: 1, mask: 4 }, // CNCX offset of the title
  { tag: 4, valuesPerEntry: 1, mask: 8 }, // depth
  { tag: 21, valuesPerEntry: 1, mask: 16 }, // parent
  { tag: 22, valuesPerEntry: 1, mask: 32 }, // first child
  { tag: 23, valuesPerEntry: 1, mask: 64 }, // last child
  { tag: 6, valuesPerEntry: 2, mask: 128 } // pos_fid
]

interface Layout {
  html: Buffer
  skeletons: Array<{ start: number; length: number }>
  chunks: Array<{ insertPos: number; length: number; selector: string }>
}

/** Lays the parts out as skeleton₀ chunk₀ skeleton₁ chunk₁ … in the HTML flow. */
function layoutParts(parts: Kf8Part[]): Layout {
  const pieces: Buffer[] = []
  const skeletons: Layout['skeletons'] = []
  const chunks: Layout['chunks'] = []
  let position = 0

  parts.forEach((part, i) => {
    const aid = toBase32(i, 4)
    const { head, tail } = buildSkeleton({ ...part, title: capTitle(part.title), aid })
    const headBytes = Buffer.from(head, 'utf-8')
    const skeleton = Buffer.concat([headBytes, Buffer.from(tail, 'utf-8')])
    const body = Buffer.from(part.body, 'utf-8')

    skeletons.push({ start: position, length: skeleton.length })
    chunks.push({ insertPos: position + headBytes.length, length: body.length, selector: `P-//*[@aid='${aid}']` })
    pieces.push(skeleton, body)
    position += skeleton.length + body.length
  })

  return { html: Buffer.concat(pieces), skeletons, chunks }
}

interface NcxEntry {
  title: string
  start: number
  length: number
  part: number
  offset: number
}

/**
 * NCX entries in reading order. Positions are in the reassembled text (chunk
 * insert position + offset), which is how calibre records them; each entry
 * runs until the next one starts. No TOC → one entry per part.
 */
function resolveToc(input: Kf8BookInput, layout: Layout): NcxEntry[] {
  const toc = input.toc.length > 0 ? input.toc : input.parts.map((p, part) => ({ title: p.title, part, offset: 0 }))
  const located = toc
    .filter((e) => e.part >= 0 && e.part < layout.chunks.length)
    .map((e) => {
      const chunk = layout.chunks[e.part]
      const offset = Math.min(Math.max(0, Math.floor(e.offset)), chunk.length)
      return { title: capTitle(e.title), part: e.part, offset, start: chunk.insertPos + offset }
    })
    .sort((a, b) => a.start - b.start)
  return located.map((e, i) => ({ ...e, length: (located[i + 1]?.start ?? layout.html.length) - e.start }))
}

function chunkIndexRecords(layout: Layout): Buffer[] {
  const cncx = buildCncx(layout.chunks.map((c) => c.selector))
  const entries = layout.chunks.map((c, i) => ({
    label: String(c.insertPos).padStart(10, '0'),
    values: { 2: [cncx.offsets[i]], 3: [i], 4: [i], 6: [0, c.length] }
  }))
  return [...buildIndex(CHUNK_TAGS, entries, cncx.records.length), ...cncx.records]
}

function skeletonIndexRecords(layout: Layout): Buffer[] {
  const entries = layout.skeletons.map((s, i) => ({
    label: `SKEL${String(i).padStart(10, '0')}`,
    values: { 1: [1, 1], 6: [s.start, s.length, s.start, s.length] }
  }))
  return buildIndex(SKELETON_TAGS, entries, 0)
}

function ncxIndexRecords(ncx: NcxEntry[]): Buffer[] {
  const cncx = buildCncx(ncx.map((e) => e.title))
  const width = Math.max(2, Math.max(0, ncx.length - 1).toString(16).length)
  const entries = ncx.map((e, i) => ({
    label: i.toString(16).toUpperCase().padStart(width, '0'),
    values: { 1: [e.start], 2: [e.length], 3: [cncx.offsets[i]], 4: [0], 6: [e.part, e.offset] }
  }))
  return [...buildIndex(NCX_TAGS, entries, cncx.records.length), ...cncx.records]
}

function exthEntries(input: Kf8BookInput, resourceCount: number): ExthEntry[] {
  const language = baseLanguage(input.language)
  const cover = input.cover
  const coverEntries = cover
    ? [
        exthString(EXTH.COVER_URI, `kindle:embed:${toBase32(cover.image + 1, 4)}`),
        exthUint32(EXTH.COVER_OFFSET, cover.image),
        ...(cover.thumbnail ? [exthUint32(EXTH.THUMB_OFFSET, input.images.length)] : []),
        exthUint32(EXTH.FAKE_COVER, 0)
      ]
    : []
  return [
    ...input.authors.filter((a) => a.trim()).map((a) => exthString(EXTH.AUTHOR, a.trim())),
    exthString(EXTH.ASIN, input.asin),
    ...(resourceCount > 0 ? [exthUint32(EXTH.RESOURCE_COUNT, resourceCount)] : []),
    exthUint32(EXTH.UNIDENTIFIED_COUNT, 0),
    ...coverEntries,
    // Identify as KindleGen 2.9, as calibre does: some firmware features key off it.
    exthUint32(EXTH.CREATOR_SOFTWARE, 202),
    exthUint32(EXTH.CREATOR_MAJOR, 2),
    exthUint32(EXTH.CREATOR_MINOR, 9),
    exthUint32(EXTH.CREATOR_BUILD, 0),
    exthString(EXTH.CONTENT_TYPE, 'EBOK'),
    exthString(EXTH.UPDATED_TITLE, input.title),
    ...(language ? [exthString(EXTH.LANGUAGE, language)] : []),
    exthString(EXTH.OVERRIDE_FONTS, 'true'),
    exthString(EXTH.CREATOR_BUILD_REV, '0730-890adc2')
  ]
}

function validate(input: Kf8BookInput): void {
  if (input.parts.length === 0) throw new RangeError('A KF8 book needs at least one part')
  if (input.cover && (input.cover.image < 0 || input.cover.image >= input.images.length)) {
    throw new RangeError(`Cover image ${input.cover.image} is not one of the ${input.images.length} images`)
  }
  for (const p of input.parts) {
    if (p.stylesheets.some((s) => s < 1 || s > input.stylesheets.length)) {
      throw new RangeError(`Part "${p.title}" links a stylesheet that does not exist`)
    }
  }
}

/** Serializes a book to an AZW3 (KF8-only MOBI) file. */
export function writeKf8(input: Kf8BookInput): Buffer {
  validate(input)
  const layout = layoutParts(input.parts)
  const ncx = resolveToc(input, layout)
  const css = input.stylesheets.map((s) => Buffer.from(s, 'utf-8'))
  const text = Buffer.concat([layout.html, ...css])
  const textRecords = buildTextRecords(text, ncx)
  const lastLength = textRecords[textRecords.length - 1].length
  // calibre pads the text section so the first index record starts 4-aligned.
  const padding = lastLength % 4 === 0 ? [] : [Buffer.alloc(4 - (lastLength % 4))]

  const records: Buffer[] = [Buffer.alloc(0), ...textRecords, ...padding]
  const firstNonBook = records.length
  const append = (more: Buffer[]): number => records.push(...more) - more.length

  const chunkIndex = append(chunkIndexRecords(layout))
  const skelIndex = append(skeletonIndexRecords(layout))
  const ncxIndex = append(ncxIndexRecords(ncx))
  const images = [...input.images, ...(input.cover?.thumbnail ? [input.cover.thumbnail] : [])]
  const firstImage = images.length > 0 ? append(images) : NULL_INDEX
  const fdstIndex = append([buildFdst([layout.html.length, ...css.map((c) => c.length)])])
  const flisIndex = append([buildFlis()])
  const fcisIndex = append([buildFcis(text.length)])
  append([EOF_RECORD])

  records[0] = buildRecord0({
    textLength: text.length,
    textRecordCount: textRecords.length,
    uniqueId: input.uniqueId,
    locale: mobiLocale(input.language),
    fullName: input.title,
    firstNonBook,
    firstImage,
    fdstIndex,
    fdstCount: 1 + css.length,
    fcisIndex,
    flisIndex,
    ncxIndex,
    chunkIndex,
    skelIndex,
    exth: exthEntries(input, images.length)
  })
  return buildPalmDb(input.title, input.created, records)
}
