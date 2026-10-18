import { promises as fs } from 'fs'

/**
 * Minimal MOBI/AZW3 header reader — just enough to name a Kindle cover thumbnail.
 *
 * The Kindle keys the home-screen thumbnail of a sideloaded book on the
 * identifier stored INSIDE the book (EXTH 504 "ASIN", or the UUID calibre writes
 * into EXTH 113) plus its content type (EXTH 501, e.g. `EBOK`). `kindleThumbnails.ts`
 * turns the pair into `thumbnail_<asin>_<cdetype>_portrait.jpg`, exactly as
 * calibre's KINDLE2 driver does.
 *
 * Layout being walked (all big-endian):
 *   PalmDB header (78 B) → `type+creator` at 60 must be `BOOKMOBI`, record count at 76
 *   record info list     → 8 B per record; the first entry is record 0's offset
 *   record 0             → PalmDOC header (16 B) + MOBI header + EXTH block
 *   MOBI header          → magic `MOBI`, its own length at +4, EXTH flags at +112
 *   EXTH block           → magic `EXTH`, length, count, then `type/len/data` triples
 *
 * Failure policy: anything unexpected (a PDF, a truncated file, a missing EXTH,
 * an identifier that is not filename-safe) yields `null`. A book we cannot
 * identify simply gets no thumbnail — never an exception mid-upload.
 */

export interface MobiIdentifiers {
  /** EXTH 504 (real ASIN) or, failing that, EXTH 113 (calibre's book UUID). */
  asin: string
  /** EXTH 501 content type; `EBOK` when the book does not declare one. */
  cdetype: string
}

const PALM_HEADER_BYTES = 78
const RECORD_ENTRY_BYTES = 8
const PALM_TYPE_CREATOR_OFFSET = 60
const PALM_RECORD_COUNT_OFFSET = 76
const MOBI_TYPE_CREATOR = 'BOOKMOBI'

/** The PalmDOC header sits between record 0's start and the MOBI header. */
const MOBI_HEADER_OFFSET = 16
const MOBI_HEADER_LENGTH_OFFSET = 4
/** EXTH flags live at offset 128 of record 0 (112 into the MOBI header). */
const EXTH_FLAGS_OFFSET = 128
const EXTH_HAS_RECORDS = 0x40
const EXTH_HEADER_BYTES = 12
const EXTH_RECORD_HEADER_BYTES = 8

const EXTH_UUID = 113
const EXTH_CDETYPE = 501
const EXTH_ASIN = 504
const DEFAULT_CDETYPE = 'EBOK'

/**
 * Record 0 is a header record — a few hundred bytes to a few KB in practice.
 * Reading a fixed prefix keeps a 50 MB book off the heap; a book whose headers
 * somehow exceed it degrades to "no identifier" rather than a partial read.
 */
const HEADER_PREFIX_BYTES = 256 * 1024

/**
 * Both values end up in a filename written to the device, so they are held to a
 * strict allow-list: no separators, no `..`, no control characters.
 */
const SAFE_ASIN = /^[A-Za-z0-9._-]{1,64}$/
const SAFE_CDETYPE = /^[A-Za-z0-9]{1,16}$/

/** Parses the identifiers out of a buffer holding at least the file's headers. */
export function parseMobiIdentifiers(head: Buffer): MobiIdentifiers | null {
  const recordZero = findRecordZeroOffset(head)
  if (recordZero === null) return null

  const exthStart = findExthStart(head, recordZero)
  if (exthStart === null) return null

  const records = readExthRecords(head, exthStart)
  const asin = records.get(EXTH_ASIN) ?? records.get(EXTH_UUID)
  const cdetype = records.get(EXTH_CDETYPE) ?? DEFAULT_CDETYPE

  if (!asin || !SAFE_ASIN.test(asin) || !SAFE_CDETYPE.test(cdetype)) return null
  return { asin, cdetype }
}

/** Validates the PalmDB header and returns record 0's absolute offset. */
function findRecordZeroOffset(head: Buffer): number | null {
  if (head.length < PALM_HEADER_BYTES + RECORD_ENTRY_BYTES) return null

  const typeCreator = head.toString(
    'latin1',
    PALM_TYPE_CREATOR_OFFSET,
    PALM_TYPE_CREATOR_OFFSET + 8
  )
  if (typeCreator !== MOBI_TYPE_CREATOR) return null
  if (head.readUInt16BE(PALM_RECORD_COUNT_OFFSET) < 1) return null

  const offset = head.readUInt32BE(PALM_HEADER_BYTES)
  return offset >= PALM_HEADER_BYTES ? offset : null
}

/** Validates the MOBI header and returns where the EXTH block starts, if any. */
function findExthStart(head: Buffer, recordZero: number): number | null {
  if (head.length < recordZero + EXTH_FLAGS_OFFSET + 4) return null

  const magicAt = recordZero + MOBI_HEADER_OFFSET
  if (head.toString('latin1', magicAt, magicAt + 4) !== 'MOBI') return null

  const flags = head.readUInt32BE(recordZero + EXTH_FLAGS_OFFSET)
  if ((flags & EXTH_HAS_RECORDS) === 0) return null

  const mobiHeaderLength = head.readUInt32BE(magicAt + MOBI_HEADER_LENGTH_OFFSET)
  return magicAt + mobiHeaderLength
}

/** Reads the EXTH `type → text` map, stopping at the first malformed record. */
function readExthRecords(head: Buffer, start: number): Map<number, string> {
  const records = new Map<number, string>()
  if (start + EXTH_HEADER_BYTES > head.length) return records
  if (head.toString('latin1', start, start + 4) !== 'EXTH') return records

  const count = head.readUInt32BE(start + 8)
  let pos = start + EXTH_HEADER_BYTES

  for (let i = 0; i < count; i++) {
    if (pos + EXTH_RECORD_HEADER_BYTES > head.length) break
    const type = head.readUInt32BE(pos)
    const length = head.readUInt32BE(pos + 4)
    if (length < EXTH_RECORD_HEADER_BYTES || pos + length > head.length) break

    const value = head
      .toString('utf-8', pos + EXTH_RECORD_HEADER_BYTES, pos + length)
      .replace(/\0+$/, '')
      .trim()
    if (value) records.set(type, value)
    pos += length
  }

  return records
}

/** Reads a book's identifiers from disk. Resolves null for anything unreadable. */
export async function readMobiIdentifiers(filePath: string): Promise<MobiIdentifiers | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(HEADER_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_PREFIX_BYTES, 0)
    return parseMobiIdentifiers(buffer.subarray(0, bytesRead))
  } catch (err) {
    console.error(
      `[mobi] Failed to read headers from ${filePath}:`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  } finally {
    if (handle) {
      await handle.close().catch((err: unknown) => {
        console.error(
          `[mobi] Failed to close ${filePath}:`,
          err instanceof Error ? err.message : String(err)
        )
      })
    }
  }
}
