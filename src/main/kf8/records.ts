import { u16, u32 } from './encoding'

/** FDST: the [start, end) byte range of every flow (flow 0 = HTML, then CSS). */
export function buildFdst(flowLengths: number[]): Buffer {
  let offset = 0
  const ranges = flowLengths.map((length) => {
    const range = Buffer.concat([u32(offset), u32(offset + length)])
    offset += length
    return range
  })
  return Buffer.concat([Buffer.from('FDST', 'latin1'), u32(12), u32(flowLengths.length), ...ranges])
}

/** FLIS: fixed contents, identical in every KindleGen/calibre file. */
export function buildFlis(): Buffer {
  return Buffer.concat([
    Buffer.from('FLIS', 'latin1'),
    u32(8),
    u16(65),
    u16(0),
    u32(0),
    u32(0xffffffff),
    u16(1),
    u16(3),
    u32(3),
    u32(1),
    u32(0xffffffff)
  ])
}

/** FCIS: fixed contents apart from the text length. */
export function buildFcis(textLength: number): Buffer {
  return Buffer.concat([
    Buffer.from('FCIS', 'latin1'),
    u32(20),
    u32(16),
    u32(2),
    u32(0),
    u32(textLength),
    u32(0),
    u32(40),
    u32(0),
    u32(40),
    u32(8),
    u16(1),
    u16(1),
    u32(0)
  ])
}

export const EOF_RECORD = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a])
