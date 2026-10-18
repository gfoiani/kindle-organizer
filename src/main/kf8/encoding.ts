/**
 * Low-level encodings shared by the KF8 writer: big-endian integers, the two
 * variable-width integer flavours the format uses, and Kindle's base-32 ids.
 */

/** The "no such record/index" sentinel MOBI headers use. */
export const NULL_INDEX = 0xffffffff

export function u8(value: number): Buffer {
  const buf = Buffer.alloc(1)
  buf.writeUInt8(value)
  return buf
}

export function u16(value: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(value)
  return buf
}

export function u32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value >>> 0)
  return buf
}

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${value}`)
  }
}

/** 7-bit groups, most significant first. */
function sevenBitGroups(value: number): number[] {
  const groups: number[] = []
  let rest = value
  do {
    groups.unshift(rest % 128)
    rest = Math.floor(rest / 128)
  } while (rest > 0)
  return groups
}

/** Forward VWI (index entries, CNCX lengths): the high bit marks the LAST byte. */
export function encodeForwardVwi(value: number): Buffer {
  assertNonNegativeInteger(value, 'VWI value')
  const groups = sevenBitGroups(value)
  return Buffer.from(groups.map((g, i) => (i === groups.length - 1 ? g | 0x80 : g)))
}

/** Backward VWI (trailing-entry sizes, read from the end): the high bit marks the FIRST byte. */
export function encodeBackwardVwi(value: number): Buffer {
  assertNonNegativeInteger(value, 'VWI value')
  const groups = sevenBitGroups(value)
  return Buffer.from(groups.map((g, i) => (i === 0 ? g | 0x80 : g)))
}

/** Kindle ids: uppercase base 32 (0-9A-V), zero-padded. */
export function toBase32(value: number, width: number): string {
  assertNonNegativeInteger(value, 'base-32 value')
  return value.toString(32).toUpperCase().padStart(width, '0')
}

/** Zero bytes needed to bring `length` up to a multiple of 4. */
export function paddingTo4(length: number): number {
  return (4 - (length % 4)) % 4
}

export function padTo4(buf: Buffer): Buffer {
  const pad = paddingTo4(buf.length)
  return pad === 0 ? buf : Buffer.concat([buf, Buffer.alloc(pad)])
}
