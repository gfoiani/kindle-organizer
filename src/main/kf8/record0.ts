import { NULL_INDEX } from './encoding'
import { buildExth, type ExthEntry } from './exth'

export const TEXT_RECORD_SIZE = 4096
/** Multibyte overlap (bit 0) + trailing byte sequences for indexing (bit 1). */
export const EXTRA_DATA_FLAGS = 0b11

const PALMDOC_HEADER_LENGTH = 16
const KF8_HEADER_LENGTH = 264
const NO_COMPRESSION = 1
const MOBI_TYPE_BOOK = 2
const UTF8 = 65001
const KF8_VERSION = 8
/** calibre's EXTH flags (bit 6 = has EXTH). */
const EXTH_FLAGS = 0b1010000
/** Zero padding calibre and KindleGen leave after the full name. */
const TRAILING_PADDING = 8192

export interface Record0Fields {
  textLength: number
  textRecordCount: number
  uniqueId: number
  locale: number
  fullName: string
  firstNonBook: number
  firstImage: number
  fdstIndex: number
  fdstCount: number
  fcisIndex: number
  flisIndex: number
  ncxIndex: number
  chunkIndex: number
  skelIndex: number
  exth: ExthEntry[]
}

function palmDocHeader(f: Record0Fields): Buffer {
  const buf = Buffer.alloc(PALMDOC_HEADER_LENGTH)
  buf.writeUInt16BE(NO_COMPRESSION, 0)
  buf.writeUInt32BE(f.textLength, 4)
  buf.writeUInt16BE(f.textRecordCount, 8)
  buf.writeUInt16BE(TEXT_RECORD_SIZE, 10)
  return buf
}

/**
 * The 264-byte KF8 MOBI header. Offsets are relative to the "MOBI" magic and
 * match what calibre writes for a KF8-only AZW3; unused index slots hold the
 * NULL_INDEX sentinel exactly where calibre puts it.
 */
function kf8Header(f: Record0Fields, fullNameOffset: number, fullNameLength: number): Buffer {
  const h = Buffer.alloc(KF8_HEADER_LENGTH)
  h.write('MOBI', 0, 'latin1')
  h.writeUInt32BE(KF8_HEADER_LENGTH, 4)
  h.writeUInt32BE(MOBI_TYPE_BOOK, 8)
  h.writeUInt32BE(UTF8, 12)
  h.writeUInt32BE(f.uniqueId >>> 0, 16)
  h.writeUInt32BE(KF8_VERSION, 20)
  // Orthographic/inflection/names/keys + six extra indexes: all unused.
  for (let offset = 24; offset <= 60; offset += 4) h.writeUInt32BE(NULL_INDEX, offset)
  h.writeUInt32BE(f.firstNonBook, 64)
  h.writeUInt32BE(fullNameOffset, 68)
  h.writeUInt32BE(fullNameLength, 72)
  h.writeUInt32BE(f.locale, 76)
  h.writeUInt32BE(KF8_VERSION, 88) // min reader version
  h.writeUInt32BE(f.firstImage, 92)
  h.writeUInt32BE(EXTH_FLAGS, 112)
  h.writeUInt32BE(NULL_INDEX, 148) // DRM offset
  h.writeUInt32BE(NULL_INDEX, 152) // DRM count
  h.writeUInt32BE(f.fdstIndex, 176)
  h.writeUInt32BE(f.fdstCount, 180)
  h.writeUInt32BE(f.fcisIndex, 184)
  h.writeUInt32BE(1, 188)
  h.writeUInt32BE(f.flisIndex, 192)
  h.writeUInt32BE(1, 196)
  h.writeUInt32BE(NULL_INDEX, 208) // SRCS index
  h.writeUInt32BE(NULL_INDEX, 216)
  h.writeUInt32BE(NULL_INDEX, 220)
  h.writeUInt32BE(EXTRA_DATA_FLAGS, 224)
  h.writeUInt32BE(f.ncxIndex, 228)
  h.writeUInt32BE(f.chunkIndex, 232)
  h.writeUInt32BE(f.skelIndex, 236)
  h.writeUInt32BE(NULL_INDEX, 240) // DATP
  h.writeUInt32BE(NULL_INDEX, 244) // guide ("other") index: not written
  h.writeUInt32BE(NULL_INDEX, 248)
  h.writeUInt32BE(NULL_INDEX, 256)
  return h
}

/** Record 0: PalmDOC header, KF8 header, EXTH, the full title, then padding. */
export function buildRecord0(fields: Record0Fields): Buffer {
  const exth = buildExth(fields.exth)
  const fullName = Buffer.from(fields.fullName, 'utf-8')
  const fullNameOffset = PALMDOC_HEADER_LENGTH + KF8_HEADER_LENGTH + exth.length
  return Buffer.concat([
    palmDocHeader(fields),
    kf8Header(fields, fullNameOffset, fullName.length),
    exth,
    fullName,
    Buffer.alloc(TRAILING_PADDING)
  ])
}
