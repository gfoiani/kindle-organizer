import { encodeBackwardVwi, encodeForwardVwi, u8 } from './encoding'
import { TEXT_RECORD_SIZE } from './record0'

/** A navigation range, in the same byte coordinates the NCX index uses. */
export interface TextRange {
  start: number
  length: number
}

/** Trailing-byte-sequence entry type calibre and leotaku/mobi write for KF8. */
const TBS_TYPE = 8
const MAX_SIBLINGS = 255

/**
 * Bytes from the start of the next record that complete a UTF-8 character
 * cut by the record boundary at `end` (0 when the boundary is clean).
 */
function overlapLength(text: Buffer, end: number): number {
  if (end >= text.length) return 0
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = text[end - back]
    if ((byte & 0xc0) === 0x80) continue // continuation byte: keep looking for the lead
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return Math.max(0, expected - back)
  }
  return 0
}

/**
 * The TBS strand for the record [from, to): port of leotaku/mobi's
 * TrailProvider (MIT). Only flat (single-level) navigation is supported.
 */
function tbsBytes(from: number, to: number, ranges: TextRange[]): Buffer {
  let index = -1
  let spans = false
  let siblings = 0

  for (const [i, r] of ranges.entries()) {
    const end = r.start + r.length
    if (r.start <= from && end >= to) {
      index = i
      spans = !(r.start === from || end === to)
      siblings = 0
      break
    }
    if ((from <= r.start && r.start <= to) || (from <= end && end <= to)) {
      if (index < 0) index = i
      siblings++
    }
  }
  if (index < 0) return Buffer.alloc(0)

  const flags = (spans ? 0b0001 : 0) | 0b0010 | (siblings > 1 ? 0b0100 : 0)
  return Buffer.concat([
    encodeForwardVwi(index * 8 + flags),
    encodeForwardVwi(TBS_TYPE),
    siblings > 1 ? u8(Math.min(siblings, MAX_SIBLINGS)) : Buffer.alloc(0),
    spans ? encodeForwardVwi(0) : Buffer.alloc(0)
  ])
}

/** A trailing entry is followed by its own size, the size counting itself. */
function sizedEntry(data: Buffer): Buffer {
  for (let sizeLength = 1; ; sizeLength++) {
    const size = encodeBackwardVwi(data.length + sizeLength)
    if (size.length === sizeLength) return Buffer.concat([data, size])
  }
}

/**
 * Splits the text into uncompressed 4096-byte records, each followed by the
 * trailing entries the extra-data flags announce: the multibyte overlap
 * (bytes completing a character cut by the boundary, then their count) and
 * the TBS indexing entry.
 */
export function buildTextRecords(text: Buffer, ranges: TextRange[]): Buffer[] {
  const records: Buffer[] = []
  for (let from = 0; from < text.length; from += TEXT_RECORD_SIZE) {
    const to = Math.min(from + TEXT_RECORD_SIZE, text.length)
    const overlap = text.subarray(to, to + overlapLength(text, to))
    records.push(
      Buffer.concat([text.subarray(from, to), overlap, u8(overlap.length), sizedEntry(tbsBytes(from, to, ranges))])
    )
  }
  return records
}
