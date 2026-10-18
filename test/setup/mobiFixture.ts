import { writeFileSync } from 'fs'

/**
 * Dependency-free MOBI/AZW3 fixture builder for tests.
 *
 * Both formats are PalmDB containers whose record 0 holds a PalmDOC header, a
 * MOBI header and (optionally) an EXTH record block — which is all
 * `mobiHeader.ts` reads. Hand-rolling the bytes here keeps the parser's tests
 * honest (real offsets, real big-endian fields) without shipping a sample book.
 */

export interface MobiFixtureOptions {
  /** EXTH 113 — the UUID calibre stamps into every book it converts. */
  uuid?: string
  /** EXTH 504 — a real Amazon ASIN. Takes precedence over the UUID. */
  asin?: string
  /** EXTH 501 — content type, e.g. 'EBOK' (book) or 'PDOC' (personal doc). */
  cdetype?: string
  /** PalmDB type+creator. Anything other than 'BOOKMOBI' is not a MOBI/AZW3. */
  typeCreator?: string
  /** Build the file with the EXTH block (and its flag) omitted. */
  withoutExth?: boolean
  /** Extra EXTH records as [type, value] pairs. */
  extraExth?: Array<[number, string]>
}

const PALM_HEADER_BYTES = 78
const RECORD_ENTRY_BYTES = 8
const PALMDOC_HEADER_BYTES = 16
const MOBI_HEADER_BYTES = 232
/** Offset of the EXTH flags field within the MOBI header (128 within record 0). */
const EXTH_FLAGS_IN_MOBI_HEADER = 112
const EXTH_HAS_RECORDS = 0x40

/** Builds an EXTH block: magic, length, count, then 8-byte-prefixed records. */
function buildExth(records: Array<[number, string]>): Buffer {
  const body = Buffer.concat(
    records.map(([type, value]) => {
      const data = Buffer.from(value, 'utf-8')
      const record = Buffer.alloc(8 + data.length)
      record.writeUInt32BE(type, 0)
      record.writeUInt32BE(8 + data.length, 4)
      data.copy(record, 8)
      return record
    })
  )

  // EXTH blocks are padded to a 4-byte boundary.
  const padding = (4 - ((12 + body.length) % 4)) % 4
  const header = Buffer.alloc(12)
  header.write('EXTH', 0, 'latin1')
  header.writeUInt32BE(12 + body.length + padding, 4)
  header.writeUInt32BE(records.length, 8)

  return Buffer.concat([header, body, Buffer.alloc(padding)])
}

/** Builds record 0: PalmDOC header + MOBI header + optional EXTH block. */
function buildRecordZero(options: MobiFixtureOptions): Buffer {
  const records: Array<[number, string]> = [
    ...(options.cdetype ? ([[501, options.cdetype]] as Array<[number, string]>) : []),
    ...(options.uuid ? ([[113, options.uuid]] as Array<[number, string]>) : []),
    ...(options.asin ? ([[504, options.asin]] as Array<[number, string]>) : []),
    ...(options.extraExth ?? [])
  ]
  const exth = options.withoutExth ? Buffer.alloc(0) : buildExth(records)

  const mobiHeader = Buffer.alloc(MOBI_HEADER_BYTES)
  mobiHeader.write('MOBI', 0, 'latin1')
  mobiHeader.writeUInt32BE(MOBI_HEADER_BYTES, 4)
  if (!options.withoutExth) {
    mobiHeader.writeUInt32BE(EXTH_HAS_RECORDS, EXTH_FLAGS_IN_MOBI_HEADER)
  }

  return Buffer.concat([Buffer.alloc(PALMDOC_HEADER_BYTES), mobiHeader, exth])
}

/** Builds a minimal two-record PalmDB whose record 0 carries the MOBI headers. */
export function buildMobi(options: MobiFixtureOptions = {}): Buffer {
  const recordZero = buildRecordZero(options)
  const recordOne = Buffer.from('book text', 'utf-8')
  const recordCount = 2

  const header = Buffer.alloc(PALM_HEADER_BYTES)
  header.write('Fixture', 0, 'latin1')
  header.write(options.typeCreator ?? 'BOOKMOBI', 60, 'latin1')
  header.writeUInt16BE(recordCount, 76)

  // Record info list, then the customary 2 bytes of padding before record 0.
  const list = Buffer.alloc(recordCount * RECORD_ENTRY_BYTES + 2)
  const recordZeroOffset = PALM_HEADER_BYTES + list.length
  list.writeUInt32BE(recordZeroOffset, 0)
  list.writeUInt32BE(recordZeroOffset + recordZero.length, RECORD_ENTRY_BYTES)

  return Buffer.concat([header, list, recordZero, recordOne])
}

/** Writes a fixture MOBI/AZW3 to `filePath` and returns the path. */
export function writeMobi(filePath: string, options: MobiFixtureOptions = {}): string {
  writeFileSync(filePath, buildMobi(options))
  return filePath
}
