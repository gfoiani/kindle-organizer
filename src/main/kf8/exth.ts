import { padTo4, u32 } from './encoding'

/** EXTH record types the writer emits. */
export const EXTH = {
  AUTHOR: 100,
  ASIN: 113,
  RESOURCE_COUNT: 125,
  COVER_URI: 129,
  UNIDENTIFIED_COUNT: 131,
  COVER_OFFSET: 201,
  THUMB_OFFSET: 202,
  FAKE_COVER: 203,
  CREATOR_SOFTWARE: 204,
  CREATOR_MAJOR: 205,
  CREATOR_MINOR: 206,
  CREATOR_BUILD: 207,
  CONTENT_TYPE: 501,
  UPDATED_TITLE: 503,
  LANGUAGE: 524,
  OVERRIDE_FONTS: 528,
  CREATOR_BUILD_REV: 535
} as const

export interface ExthEntry {
  type: number
  data: Buffer
}

export function exthString(type: number, value: string): ExthEntry {
  return { type, data: Buffer.from(value, 'utf-8') }
}

export function exthUint32(type: number, value: number): ExthEntry {
  return { type, data: u32(value) }
}

const ENTRY_HEADER_LENGTH = 8
const SECTION_HEADER_LENGTH = 12

/** Serializes the EXTH block, padded to 4 bytes (the length field excludes the padding). */
export function buildExth(entries: ExthEntry[]): Buffer {
  const body = entries.map((e) =>
    Buffer.concat([u32(e.type), u32(ENTRY_HEADER_LENGTH + e.data.length), e.data])
  )
  const length = SECTION_HEADER_LENGTH + body.reduce((sum, b) => sum + b.length, 0)
  return padTo4(Buffer.concat([Buffer.from('EXTH', 'latin1'), u32(length), u32(entries.length), ...body]))
}
