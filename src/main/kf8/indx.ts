import { encodeForwardVwi, NULL_INDEX, padTo4, u16, u32, u8 } from './encoding'

/** One TAGX row: which tag, how many values one entry of it holds, and its control-byte mask. */
export interface TagDef {
  tag: number
  valuesPerEntry: number
  mask: number
}

export interface IndexEntryInput {
  /** ASCII label; entries must already be in ascending label order. */
  label: string
  /** Values per tag. A tag absent here is simply not written for this entry. */
  values: Partial<Record<number, number[]>>
}

const INDX_HEADER_LENGTH = 192
const TAGX_OFFSET_FIELD = 180
const UTF8 = 65001
/** IDXT offsets are 16-bit, so an index record must stay addressable by them. */
const MAX_INDEX_RECORD = 0xff00

function maskShift(mask: number): number {
  let shift = 0
  while (((mask >> shift) & 1) === 0) shift++
  return shift
}

function controlByte(tags: TagDef[], entry: IndexEntryInput): number {
  return tags.reduce((cb, t) => {
    const values = entry.values[t.tag]
    if (!values || values.length === 0) return cb
    const count = values.length / t.valuesPerEntry
    const bits = count << maskShift(t.mask)
    if (!Number.isInteger(count) || (bits & t.mask) !== bits) {
      throw new RangeError(`Tag ${t.tag} of "${entry.label}" has ${values.length} values; cannot encode`)
    }
    return cb | bits
  }, 0)
}

function encodeEntry(tags: TagDef[], entry: IndexEntryInput): Buffer {
  const label = Buffer.from(entry.label, 'latin1')
  const values = tags.flatMap((t) => (entry.values[t.tag] ?? []).map(encodeForwardVwi))
  return Buffer.concat([u8(label.length), label, u8(controlByte(tags, entry)), ...values])
}

function encodeTagx(tags: TagDef[]): Buffer {
  const rows = tags.map((t) => Buffer.from([t.tag, t.valuesPerEntry, t.mask, 0]))
  const endRow = Buffer.from([0, 0, 0, 1])
  const length = 12 + (rows.length + 1) * 4
  return Buffer.concat([Buffer.from('TAGX', 'latin1'), u32(length), u32(1), ...rows, endRow])
}

interface HeaderFields {
  headerType: number
  indexType: number
  entryCount: number
  encoding: number
  totalEntries: number
  cncxCount: number
  tagxOffset: number
}

function indxHeader(f: HeaderFields, idxtStart: number): Buffer {
  const h = Buffer.alloc(INDX_HEADER_LENGTH)
  h.write('INDX', 0, 'latin1')
  h.writeUInt32BE(INDX_HEADER_LENGTH, 4)
  h.writeUInt32BE(f.headerType, 12)
  h.writeUInt32BE(f.indexType, 16)
  h.writeUInt32BE(idxtStart, 20)
  h.writeUInt32BE(f.entryCount, 24)
  h.writeUInt32BE(f.encoding, 28)
  h.writeUInt32BE(NULL_INDEX, 32) // language
  h.writeUInt32BE(f.totalEntries, 36)
  h.writeUInt32BE(f.cncxCount, 52)
  h.writeUInt32BE(f.tagxOffset, TAGX_OFFSET_FIELD)
  return h
}

/** Header + optional TAGX + entries, then the IDXT table of entry offsets. */
function indexRecord(fields: Omit<HeaderFields, 'entryCount'>, prefix: Buffer, entries: Buffer[]): Buffer {
  const offsets: number[] = []
  let offset = INDX_HEADER_LENGTH + prefix.length
  for (const e of entries) {
    offsets.push(offset)
    offset += e.length
  }
  const body = padTo4(Buffer.concat([prefix, ...entries]))
  const idxtStart = INDX_HEADER_LENGTH + body.length
  const idxt = padTo4(Buffer.concat([Buffer.from('IDXT', 'latin1'), ...offsets.map(u16)]))
  return Buffer.concat([indxHeader({ ...fields, entryCount: entries.length }, idxtStart), body, idxt])
}

/** Greedily packs encoded entries into records that fit the 16-bit IDXT offsets. */
function packRecords(encoded: Buffer[]): Buffer[][] {
  const groups: Buffer[][] = [[]]
  let size = INDX_HEADER_LENGTH + 8
  for (const e of encoded) {
    const cost = e.length + 2
    if (groups[groups.length - 1].length > 0 && size + cost > MAX_INDEX_RECORD) {
      groups.push([])
      size = INDX_HEADER_LENGTH + 8
    }
    groups[groups.length - 1].push(e)
    size += cost
  }
  return groups
}

/**
 * Builds an index: one header record (TAGX + one summary entry per data record)
 * followed by the data records. The caller appends the CNCX records, whose
 * count the header announces.
 */
export function buildIndex(tags: TagDef[], entries: IndexEntryInput[], cncxCount: number): Buffer[] {
  const encoded = entries.map((e) => encodeEntry(tags, e))
  const groups = packRecords(encoded)

  let consumed = 0
  const summaries = groups.map((group) => {
    consumed += group.length
    const lastLabel = Buffer.from(entries[consumed - 1]?.label ?? '', 'latin1')
    return Buffer.concat([u8(lastLabel.length), lastLabel, u16(group.length)])
  })

  const dataFields = { headerType: 1, indexType: 0, encoding: NULL_INDEX, totalEntries: 0, cncxCount: 0, tagxOffset: 0 }
  const dataRecords = groups.map((group) => indexRecord(dataFields, Buffer.alloc(0), group))

  const header = indexRecord(
    {
      headerType: 0,
      indexType: 2,
      encoding: UTF8,
      totalEntries: entries.length,
      cncxCount,
      tagxOffset: INDX_HEADER_LENGTH
    },
    encodeTagx(tags),
    summaries
  )
  return [header, ...dataRecords]
}
