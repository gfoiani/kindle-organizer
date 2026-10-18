/**
 * Minimal, independent KF8 (AZW3) reader for tests.
 *
 * Deliberately written from the format's reader-side semantics (as the device
 * and calibre's MOBI8 reader interpret a file) rather than by calling back into
 * the writer, so a test that round-trips a book through it checks the writer
 * against the spec instead of against itself.
 */

export interface PdbFile {
  name: string
  typeCreator: string
  records: Buffer[]
  uids: number[]
}

export interface IndexEntry {
  label: string
  tags: Record<number, number[]>
}

export interface Index {
  entries: IndexEntry[]
  /** CNCX strings keyed by the offset entries use to reference them. */
  cncx: Map<number, string>
  headerFields: { indexType: number; dataRecordCount: number; totalEntries: number; cncxCount: number }
}

export interface Record0 {
  compression: number
  textLength: number
  textRecordCount: number
  textRecordSize: number
  headerLength: number
  mobiType: number
  encoding: number
  uniqueId: number
  fileVersion: number
  firstNonBook: number
  fullName: string
  locale: number
  minVersion: number
  firstImage: number
  exthFlags: number
  fdstIndex: number
  fdstCount: number
  fcisIndex: number
  flisIndex: number
  extraDataFlags: number
  ncxIndex: number
  chunkIndex: number
  skelIndex: number
  guideIndex: number
  exth: Array<{ type: number; data: Buffer }>
}

export interface Kf8Book {
  pdb: PdbFile
  header: Record0
  /** The whole text (all flows), trailing bytes stripped. */
  text: Buffer
  flows: Buffer[]
  skeletons: IndexEntry[]
  chunks: Index
  ncx: Index
  /** Each file reassembled from its skeleton + chunks, as the device renders it. */
  parts: string[]
  images: Buffer[]
}

export function readPdb(file: Buffer): PdbFile {
  const name = file.subarray(0, 32).toString('latin1').replace(/\0.*$/s, '')
  const typeCreator = file.subarray(60, 68).toString('latin1')
  const count = file.readUInt16BE(76)
  const offsets: number[] = []
  const uids: number[] = []
  for (let i = 0; i < count; i++) {
    offsets.push(file.readUInt32BE(78 + i * 8))
    uids.push(file.readUInt32BE(82 + i * 8) & 0xffffff)
  }
  const records = offsets.map((start, i) => file.subarray(start, offsets[i + 1] ?? file.length))
  return { name, typeCreator, records, uids }
}

export function readRecord0(rec: Buffer): Record0 {
  const m = 16
  const headerLength = rec.readUInt32BE(m + 4)
  const exthStart = m + headerLength
  const exth: Array<{ type: number; data: Buffer }> = []
  if (rec.subarray(exthStart, exthStart + 4).toString('latin1') === 'EXTH') {
    const count = rec.readUInt32BE(exthStart + 8)
    let p = exthStart + 12
    for (let i = 0; i < count; i++) {
      const type = rec.readUInt32BE(p)
      const len = rec.readUInt32BE(p + 4)
      exth.push({ type, data: rec.subarray(p + 8, p + len) })
      p += len
    }
  }
  const fullNameOffset = rec.readUInt32BE(m + 68)
  const fullNameLength = rec.readUInt32BE(m + 72)
  return {
    compression: rec.readUInt16BE(0),
    textLength: rec.readUInt32BE(4),
    textRecordCount: rec.readUInt16BE(8),
    textRecordSize: rec.readUInt16BE(10),
    headerLength,
    mobiType: rec.readUInt32BE(m + 8),
    encoding: rec.readUInt32BE(m + 12),
    uniqueId: rec.readUInt32BE(m + 16),
    fileVersion: rec.readUInt32BE(m + 20),
    firstNonBook: rec.readUInt32BE(m + 64),
    fullName: rec.subarray(fullNameOffset, fullNameOffset + fullNameLength).toString('utf-8'),
    locale: rec.readUInt32BE(m + 76),
    minVersion: rec.readUInt32BE(m + 88),
    firstImage: rec.readUInt32BE(m + 92),
    exthFlags: rec.readUInt32BE(m + 112),
    fdstIndex: rec.readUInt32BE(m + 176),
    fdstCount: rec.readUInt32BE(m + 180),
    fcisIndex: rec.readUInt32BE(m + 184),
    flisIndex: rec.readUInt32BE(m + 192),
    extraDataFlags: rec.readUInt32BE(m + 224),
    ncxIndex: rec.readUInt32BE(m + 228),
    chunkIndex: rec.readUInt32BE(m + 232),
    skelIndex: rec.readUInt32BE(m + 236),
    guideIndex: rec.readUInt32BE(m + 244),
    exth
  }
}

export function exthStrings(header: Record0, type: number): string[] {
  return header.exth.filter((e) => e.type === type).map((e) => e.data.toString('utf-8'))
}

export function exthInt(header: Record0, type: number): number | undefined {
  const entry = header.exth.find((e) => e.type === type)
  return entry ? entry.data.readUInt32BE(0) : undefined
}

/** Forward variable-width integer: 7 bits per byte, high bit marks the LAST byte. */
function readForwardVwi(buf: Buffer, pos: number): [number, number] {
  let value = 0
  let p = pos
  for (;;) {
    const byte = buf[p++]
    value = value * 128 + (byte & 0x7f)
    if (byte & 0x80) return [value, p - pos]
  }
}

/** Backward VWI read from the end: high bit marks the FIRST (most significant) byte. */
function readBackwardVwi(buf: Buffer): number {
  let value = 0
  let shift = 0
  for (let p = buf.length - 1; p >= Math.max(0, buf.length - 4); p--) {
    const byte = buf[p]
    value |= (byte & 0x7f) << shift
    shift += 7
    if (byte & 0x80) break
  }
  return value
}

/** Strips the trailing entries a text record carries, per the extra-data flags. */
export function stripTrailing(record: Buffer, flags: number): Buffer {
  let data = record
  for (let bit = 15; bit >= 1; bit--) {
    if (flags & (1 << bit)) data = data.subarray(0, data.length - readBackwardVwi(data))
  }
  if (flags & 1) data = data.subarray(0, data.length - ((data[data.length - 1] & 0x3) + 1))
  return data
}

/** The trailing entries of a text record, split into multibyte overlap and TBS bytes. */
export function trailingParts(record: Buffer, flags: number): { overlap: Buffer; tbs: Buffer } {
  let data = record
  let tbs = Buffer.alloc(0)
  if (flags & 2) {
    const size = readBackwardVwi(data)
    tbs = data.subarray(data.length - size, data.length - 1)
    data = data.subarray(0, data.length - size)
  }
  const mb = data[data.length - 1] & 0x3
  return { overlap: data.subarray(data.length - 1 - mb, data.length - 1), tbs }
}

interface TagxTag {
  tag: number
  valuesPerEntry: number
  mask: number
  end: boolean
}

function readTagx(rec: Buffer, offset: number): { controlByteCount: number; tags: TagxTag[] } {
  const length = rec.readUInt32BE(offset + 4)
  const controlByteCount = rec.readUInt32BE(offset + 8)
  const tags: TagxTag[] = []
  for (let p = offset + 12; p < offset + length; p += 4) {
    tags.push({ tag: rec[p], valuesPerEntry: rec[p + 1], mask: rec[p + 2], end: rec[p + 3] === 1 })
  }
  return { controlByteCount, tags }
}

function maskShift(mask: number): number {
  let shift = 0
  while (((mask >> shift) & 1) === 0) shift++
  return shift
}

function readIndexEntries(rec: Buffer, tagx: { controlByteCount: number; tags: TagxTag[] }): IndexEntry[] {
  const idxtStart = rec.readUInt32BE(20)
  const count = rec.readUInt32BE(24)
  if (rec.subarray(idxtStart, idxtStart + 4).toString('latin1') !== 'IDXT') {
    throw new Error(`IDXT missing at ${idxtStart}`)
  }
  const offsets = Array.from({ length: count }, (_, i) => rec.readUInt16BE(idxtStart + 4 + i * 2))
  return offsets.map((start) => {
    const labelLength = rec[start]
    const label = rec.subarray(start + 1, start + 1 + labelLength).toString('latin1')
    let p = start + 1 + labelLength
    const controlBytes = rec.subarray(p, p + tagx.controlByteCount)
    p += tagx.controlByteCount
    const tags: Record<number, number[]> = {}
    let cbIndex = 0
    for (const t of tagx.tags) {
      if (t.end) {
        cbIndex++
        continue
      }
      const value = controlBytes[cbIndex] & t.mask
      if (value === 0) continue
      const entryCount = value >> maskShift(t.mask)
      const values: number[] = []
      for (let i = 0; i < entryCount * t.valuesPerEntry; i++) {
        const [v, used] = readForwardVwi(rec, p)
        values.push(v)
        p += used
      }
      tags[t.tag] = values
    }
    return { label, tags }
  })
}

function readCncx(records: Buffer[]): Map<number, string> {
  const map = new Map<number, string>()
  records.forEach((rec, recordIndex) => {
    let p = 0
    while (p < rec.length) {
      if (rec[p] === 0) break // trailing alignment padding
      const [len, used] = readForwardVwi(rec, p)
      map.set((recordIndex << 16) | p, rec.subarray(p + used, p + used + len).toString('utf-8'))
      p += used + len
    }
  })
  return map
}

export function readIndex(records: Buffer[], headerIndex: number): Index {
  const header = records[headerIndex]
  if (header.subarray(0, 4).toString('latin1') !== 'INDX') throw new Error('not an INDX record')
  const tagx = readTagx(header, header.readUInt32BE(180))
  const dataRecordCount = header.readUInt32BE(24)
  const cncxCount = header.readUInt32BE(52)
  const entries: IndexEntry[] = []
  for (let i = 1; i <= dataRecordCount; i++) {
    entries.push(...readIndexEntries(records[headerIndex + i], tagx))
  }
  const cncxStart = headerIndex + 1 + dataRecordCount
  return {
    entries,
    cncx: readCncx(records.slice(cncxStart, cncxStart + cncxCount)),
    headerFields: {
      indexType: header.readUInt32BE(16),
      dataRecordCount,
      totalEntries: header.readUInt32BE(36),
      cncxCount
    }
  }
}

/** The header record's own IDXT entries: [lastLabel, entryCount] per data record. */
export function readIndexHeaderEntries(header: Buffer): Array<{ label: string; count: number }> {
  const idxtStart = header.readUInt32BE(20)
  const count = header.readUInt32BE(24)
  return Array.from({ length: count }, (_, i) => {
    const start = header.readUInt16BE(idxtStart + 4 + i * 2)
    const len = header[start]
    return {
      label: header.subarray(start + 1, start + 1 + len).toString('latin1'),
      count: header.readUInt16BE(start + 1 + len)
    }
  })
}

function readFdst(rec: Buffer): Array<[number, number]> {
  const count = rec.readUInt32BE(8)
  return Array.from({ length: count }, (_, i) => [rec.readUInt32BE(12 + i * 8), rec.readUInt32BE(16 + i * 8)])
}

/** Rebuilds every file the way calibre's MOBI8 reader does: skeleton + inserted chunks. */
function assembleParts(html: Buffer, skeletons: IndexEntry[], chunks: IndexEntry[]): string[] {
  let chunkPointer = 0
  return skeletons.map((skel) => {
    const [chunkCount] = skel.tags[1]
    const [skelStart, skelLength] = skel.tags[6]
    let part = Buffer.from(html.subarray(skelStart, skelStart + skelLength))
    let base = skelStart + skelLength
    for (let i = 0; i < chunkCount; i++) {
      const chunk = chunks[chunkPointer++]
      const insertPos = parseInt(chunk.label, 10) - skelStart
      const length = chunk.tags[6][1]
      const slice = html.subarray(base, base + length)
      part = Buffer.concat([part.subarray(0, insertPos), slice, part.subarray(insertPos)])
      base += length
    }
    return part.toString('utf-8')
  })
}

export function readKf8(file: Buffer): Kf8Book {
  const pdb = readPdb(file)
  const header = readRecord0(pdb.records[0])
  const textRecords = pdb.records.slice(1, 1 + header.textRecordCount)
  const text = Buffer.concat(textRecords.map((r) => stripTrailing(r, header.extraDataFlags)))
  const fdst = readFdst(pdb.records[header.fdstIndex])
  const flows = fdst.map(([start, end]) => text.subarray(start, end))
  const skel = readIndex(pdb.records, header.skelIndex)
  const chunks = readIndex(pdb.records, header.chunkIndex)
  const ncx = readIndex(pdb.records, header.ncxIndex)
  const resourceCount = header.exth.find((e) => e.type === 125)?.data.readUInt32BE(0) ?? 0
  const images =
    header.firstImage === 0xffffffff
      ? []
      : pdb.records.slice(header.firstImage, header.firstImage + resourceCount)
  return {
    pdb,
    header,
    text,
    flows,
    skeletons: skel.entries,
    chunks,
    ncx,
    parts: assembleParts(flows[0], skel.entries, chunks.entries),
    images
  }
}
