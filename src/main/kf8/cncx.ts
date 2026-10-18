import { encodeForwardVwi, padTo4 } from './encoding'

/**
 * Index entries address a CNCX string as `(recordIndex << 16) | offsetInRecord`,
 * so a single CNCX record can never grow past 64 KiB. Stay a little below it.
 */
const MAX_CNCX_RECORD = 0xfff0

export interface Cncx {
  records: Buffer[]
  /** Offset of each input string, in input order. */
  offsets: number[]
}

/** Packs length-prefixed UTF-8 strings into as many CNCX records as needed. */
export function buildCncx(strings: string[]): Cncx {
  const records: Buffer[][] = [[]]
  const offsets: number[] = []
  let used = 0

  for (const s of strings) {
    const bytes = Buffer.from(s, 'utf-8')
    const entry = Buffer.concat([encodeForwardVwi(bytes.length), bytes])
    if (used + entry.length > MAX_CNCX_RECORD) {
      records.push([])
      used = 0
    }
    offsets.push(((records.length - 1) << 16) | used)
    records[records.length - 1].push(entry)
    used += entry.length
  }

  return { records: records.map((r) => padTo4(Buffer.concat(r))), offsets }
}
