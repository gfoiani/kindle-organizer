import { u16, u32 } from './encoding'

const NAME_LENGTH = 32
const MAX_NAME_BYTES = NAME_LENGTH - 1
const HEADER_LENGTH = 78
const RECORD_ENTRY_LENGTH = 8
/** Two zero bytes traditionally separate the record list from the first record. */
const GAP_LENGTH = 2
/** The record count is a 16-bit field. */
const MAX_RECORDS = 0xffff

/**
 * The PalmDB name is a 31-byte NUL-terminated field that readers treat as
 * Latin-1, so non-ASCII titles are folded the way calibre does: accents
 * stripped, anything else outside [A-Za-z0-9] turned into `_`.
 */
export function palmDbName(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '_')
    .slice(0, MAX_NAME_BYTES)
  return ascii.replace(/^_+$/, '') || 'book'
}

/**
 * Serializes a PalmDB container ("BOOKMOBI") around the given records.
 * Record ids follow calibre's convention of doubling the index.
 */
export function buildPalmDb(title: string, created: Date, records: Buffer[]): Buffer {
  if (records.length > MAX_RECORDS) {
    throw new RangeError(`A PalmDB holds at most ${MAX_RECORDS} records; this book needs ${records.length}`)
  }
  const name = Buffer.alloc(NAME_LENGTH)
  name.write(palmDbName(title), 'latin1')
  // calibre stores a Unix timestamp here; readers only display it.
  const timestamp = Math.floor(created.getTime() / 1000)

  const header = Buffer.concat([
    name,
    u16(0), // attributes
    u16(0), // version
    u32(timestamp), // creation
    u32(timestamp), // modification
    u32(0), // last backup
    u32(0), // modification number
    u32(0), // app info
    u32(0), // sort info
    Buffer.from('BOOKMOBI', 'latin1'),
    u32(records.length * 2 - 1), // unique id seed
    u32(0), // next record list
    u16(records.length)
  ])

  let offset = HEADER_LENGTH + RECORD_ENTRY_LENGTH * records.length + GAP_LENGTH
  const entries = records.map((record, i) => {
    const entry = Buffer.alloc(RECORD_ENTRY_LENGTH)
    entry.writeUInt32BE(offset, 0)
    // Byte 4 holds the attributes (0); bytes 5-7 the 24-bit record id.
    entry.writeUIntBE(i * 2, 5, 3)
    offset += record.length
    return entry
  })

  return Buffer.concat([header, ...entries, Buffer.alloc(GAP_LENGTH), ...records])
}
