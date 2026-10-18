import { describe, expect, test } from 'vitest'
import {
  writeKf8,
  kindleEmbedUri,
  kindlePosUri,
  type Kf8BookInput,
  type Kf8Part
} from '../src/main/kf8'
import { parseMobiIdentifiers } from '../src/main/mobiHeader'
import {
  exthInt,
  exthStrings,
  readIndexHeaderEntries,
  readKf8,
  trailingParts
} from './setup/kf8Reader'

const ASIN = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

function part(body: string, title = 'Chapter', overrides: Partial<Kf8Part> = {}): Kf8Part {
  return { title, stylesheets: [], body, ...overrides }
}

function book(overrides: Partial<Kf8BookInput> = {}): Kf8BookInput {
  return {
    title: 'Il nome della rosa',
    authors: ['Umberto Eco'],
    language: 'it',
    asin: ASIN,
    uniqueId: 0x2b2f8a9d,
    created: new Date('2026-10-18T09:00:00Z'),
    parts: [part('<h1>Uno</h1><p>primo</p>', 'Uno'), part('<h1>Due</h1><p id="sec">secondo</p>', 'Due')],
    stylesheets: [],
    images: [],
    toc: [
      { title: 'Uno', part: 0, offset: 0 },
      { title: 'Due', part: 1, offset: 0 }
    ],
    ...overrides
  }
}

/** Byte position of `needle` inside the reassembled book (all parts back to back). */
function assembledPosition(parts: string[], partIndex: number, needle: string): number {
  const before = Buffer.byteLength(parts.slice(0, partIndex).join(''))
  const within = Buffer.byteLength(parts[partIndex].slice(0, parts[partIndex].indexOf(needle)))
  return before + within
}

describe('writeKf8 — container and record 0', () => {
  test('writes a BOOKMOBI PalmDB whose record 0 is an uncompressed KF8 header', () => {
    // Act
    const kf8 = readKf8(writeKf8(book()))

    // Assert
    expect(kf8.pdb.typeCreator).toBe('BOOKMOBI')
    expect(kf8.pdb.uids).toEqual(kf8.pdb.records.map((_, i) => i * 2))
    expect(kf8.header).toMatchObject({
      compression: 1,
      textRecordSize: 4096,
      headerLength: 264,
      mobiType: 2,
      encoding: 65001,
      fileVersion: 8,
      minVersion: 8,
      uniqueId: 0x2b2f8a9d,
      extraDataFlags: 0b11,
      fullName: 'Il nome della rosa'
    })
  })

  test('stamps title, authors, language, identifier and the EBOK content type into EXTH', () => {
    const kf8 = readKf8(writeKf8(book({ authors: ['Umberto Eco', 'Altro Autore'] })))

    expect(exthStrings(kf8.header, 503)).toEqual(['Il nome della rosa'])
    expect(exthStrings(kf8.header, 100)).toEqual(['Umberto Eco', 'Altro Autore'])
    expect(exthStrings(kf8.header, 524)).toEqual(['it'])
    expect(exthStrings(kf8.header, 113)).toEqual([ASIN])
    expect(exthStrings(kf8.header, 501)).toEqual(['EBOK'])
  })

  test('maps the book language onto the MOBI locale code', () => {
    expect(readKf8(writeKf8(book({ language: 'it-IT' }))).header.locale).toBe(16)
    expect(readKf8(writeKf8(book({ language: 'en' }))).header.locale).toBe(9)
    expect(readKf8(writeKf8(book({ language: 'xx' }))).header.locale).toBe(0)
  })

  test('produces identifiers the thumbnail writer can read back', () => {
    expect(parseMobiIdentifiers(writeKf8(book()))).toEqual({ asin: ASIN, cdetype: 'EBOK' })
  })

  test('keeps the PalmDB name ASCII-only and within 31 bytes', () => {
    const kf8 = readKf8(writeKf8(book({ title: 'Città: è un titolo davvero molto lungo per palm' })))

    expect(kf8.pdb.name).toMatch(/^[A-Za-z0-9_]{1,31}$/)
    expect(kf8.pdb.name.startsWith('Citta_')).toBe(true)
  })
})

describe('writeKf8 — text, skeletons and chunks', () => {
  test('reassembles every part with its body inside an aid-tagged <body>', () => {
    const kf8 = readKf8(writeKf8(book()))

    expect(kf8.parts).toHaveLength(2)
    expect(kf8.parts[0]).toMatch(/<body aid="0000"><h1>Uno<\/h1><p>primo<\/p><\/body>/)
    expect(kf8.parts[1]).toMatch(/<body aid="0001"><h1>Due<\/h1><p id="sec">secondo<\/p><\/body>/)
    expect(kf8.parts[0]).toContain('<title>Uno</title>')
  })

  test('points each chunk selector at its skeleton body', () => {
    const kf8 = readKf8(writeKf8(book()))

    const selectors = kf8.chunks.entries.map((e) => kf8.chunks.cncx.get(e.tags[2][0]))
    expect(selectors).toEqual(["P-//*[@aid='0000']", "P-//*[@aid='0001']"])
  })

  test('escapes titles and carries html/body attributes into the skeleton', () => {
    const kf8 = readKf8(
      writeKf8(
        book({
          parts: [
            part('<p>x</p>', 'A & "B" <C>', {
              htmlAttributes: { lang: 'it' },
              bodyAttributes: { class: 'calibre', aid: 'ignored' }
            })
          ],
          toc: []
        })
      )
    )

    expect(kf8.parts[0]).toContain('<title>A &amp; &quot;B&quot; &lt;C&gt;</title>')
    expect(kf8.parts[0]).toMatch(/<html xmlns="http:\/\/www.w3.org\/1999\/xhtml" lang="it">/)
    expect(kf8.parts[0]).toContain('<body class="calibre" aid="0000">')
  })

  test('stores each stylesheet as its own flow, linked from the parts that use it', () => {
    const kf8 = readKf8(
      writeKf8(
        book({
          stylesheets: ['p { margin: 0 }', 'h1 { color: red }'],
          parts: [part('<p>a</p>', 'A', { stylesheets: [2, 1] })],
          toc: []
        })
      )
    )

    expect(kf8.header.fdstCount).toBe(3)
    expect(kf8.flows.slice(1).map((f) => f.toString())).toEqual(['p { margin: 0 }', 'h1 { color: red }'])
    expect(kf8.parts[0].indexOf('kindle:flow:0002?mime=text/css')).toBeLessThan(
      kf8.parts[0].indexOf('kindle:flow:0001?mime=text/css')
    )
    expect(kf8.header.textLength).toBe(kf8.text.length)
  })

  test('splits text into 4096-byte records without corrupting a multibyte character at a boundary', () => {
    // Arrange: "à" is 2 bytes in UTF-8, so an odd skeleton length leaves a
    // character straddling the 4096-byte record boundary.
    const body = `<p>${'à'.repeat(6000)}</p>`

    // Act
    const file = writeKf8(book({ parts: [part(body)], toc: [] }))
    const kf8 = readKf8(file)

    // Assert
    expect(kf8.header.textRecordCount).toBeGreaterThan(2)
    expect(kf8.parts[0]).toContain(body)
    const straddling = kf8.pdb.records
      .slice(1, 1 + kf8.header.textRecordCount)
      .map((r) => trailingParts(r, 0b11).overlap.length)
    expect(straddling.some((n) => n > 0)).toBe(true)
  })

  test('marks text records with the same trailing byte sequence calibre writes', () => {
    // Two NCX entries that both start and end inside the only text record.
    const kf8 = readKf8(writeKf8(book()))

    expect([...trailingParts(kf8.pdb.records[1], 0b11).tbs]).toEqual([0x86, 0x88, 0x02])
  })
})

describe('writeKf8 — navigation', () => {
  test('writes NCX entries with titles, assembled positions and pos_fid', () => {
    // Arrange: the second entry targets the <p id="sec"> inside part 1.
    const body = '<h1>Due</h1><p id="sec">secondo</p>'
    const offset = Buffer.byteLength(body.slice(0, body.indexOf('<p id="sec"')))
    const kf8 = readKf8(
      writeKf8(
        book({
          toc: [
            { title: 'Uno', part: 0, offset: 0 },
            { title: 'Sezione', part: 1, offset }
          ]
        })
      )
    )

    // Act
    const [first, second] = kf8.ncx.entries

    // Assert
    expect(kf8.ncx.cncx.get(first.tags[3][0])).toBe('Uno')
    expect(kf8.ncx.cncx.get(second.tags[3][0])).toBe('Sezione')
    expect(second.tags[6]).toEqual([1, offset])
    expect(second.tags[1][0]).toBe(assembledPosition(kf8.parts, 1, '<p id="sec"'))
    expect(first.tags[1][0] + first.tags[2][0]).toBe(second.tags[1][0])
    expect(second.tags[4]).toEqual([0])
  })

  test('falls back to one NCX entry per part when the book has no TOC', () => {
    const kf8 = readKf8(writeKf8(book({ toc: [] })))

    expect(kf8.ncx.entries.map((e) => kf8.ncx.cncx.get(e.tags[3][0]))).toEqual(['Uno', 'Due'])
  })

  test('builds kindle:pos links that resolve to the target element', () => {
    const target = '<h1>Due</h1><p id="sec">secondo</p>'
    const offset = Buffer.byteLength(target.slice(0, target.indexOf('<p id="sec"')))
    const link = kindlePosUri(1, offset)
    const kf8 = readKf8(writeKf8(book({ parts: [part(`<a href="${link}">vai</a>`), part(target)] })))

    const [, fid, off] = link.match(/^kindle:pos:fid:([0-9A-V]{4}):off:([0-9A-V]{10})$/) ?? []
    const chunk = kf8.chunks.entries[parseInt(fid, 32)]
    const position = parseInt(chunk.label, 10) + parseInt(off, 32)
    expect(position).toBe(assembledPosition(kf8.parts, 1, '<p id="sec"'))
  })
})

describe('writeKf8 — resources', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)])
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40, 2)])
  const thumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 3)])

  test('stores images as resources and records the cover and thumbnail in EXTH', () => {
    const kf8 = readKf8(writeKf8(book({ images: [png, jpeg], cover: { image: 1, thumbnail: thumb } })))

    expect(kf8.images).toEqual([png, jpeg, thumb])
    expect(exthInt(kf8.header, 125)).toBe(3)
    expect(exthInt(kf8.header, 201)).toBe(1)
    expect(exthInt(kf8.header, 202)).toBe(2)
    expect(exthStrings(kf8.header, 129)).toEqual(['kindle:embed:0002'])
  })

  test('writes no image index when the book has no images', () => {
    const kf8 = readKf8(writeKf8(book()))

    expect(kf8.header.firstImage).toBe(0xffffffff)
    expect(exthInt(kf8.header, 201)).toBeUndefined()
  })

  test('formats embed URIs with a 1-based base-32 index', () => {
    expect(kindleEmbedUri(0, 'image/jpeg')).toBe('kindle:embed:0001?mime=image/jpeg')
    expect(kindleEmbedUri(30, 'image/png')).toBe('kindle:embed:000V?mime=image/png')
    expect(kindleEmbedUri(31, 'image/png')).toBe('kindle:embed:0010?mime=image/png')
  })
})

describe('writeKf8 — large books', () => {
  test('splits indexes and CNCX across records and keeps every entry readable', () => {
    // Arrange: enough parts that the chunk/NCX indexes and their CNCX strings
    // cannot fit the 64 KiB a single INDX/CNCX record can address.
    const count = 5000
    const parts = Array.from({ length: count }, (_, i) => part(`<p>${i}</p>`, `Capitolo numero ${i} — titolo`))

    // Act
    const kf8 = readKf8(writeKf8(book({ parts, toc: [] })))

    // Assert
    expect(kf8.parts).toHaveLength(count)
    expect(kf8.parts[count - 1]).toContain(`<p>${count - 1}</p>`)
    expect(kf8.chunks.headerFields.dataRecordCount).toBeGreaterThan(1)
    expect(kf8.chunks.headerFields.totalEntries).toBe(count)
    expect(kf8.ncx.headerFields.cncxCount).toBeGreaterThan(1)
    const titles = kf8.ncx.entries.map((e) => kf8.ncx.cncx.get(e.tags[3][0]))
    expect(titles[count - 1]).toBe(`Capitolo numero ${count - 1} — titolo`)
    const labels = kf8.ncx.entries.map((e) => e.label)
    expect([...labels].sort()).toEqual(labels)
  })

  test('lists the last label and entry count of each data record in the index header', () => {
    const parts = Array.from({ length: 5000 }, (_, i) => part(`<p>${i}</p>`))
    const file = writeKf8(book({ parts, toc: [] }))
    const kf8 = readKf8(file)

    const header = kf8.pdb.records[kf8.header.chunkIndex]
    const summary = readIndexHeaderEntries(header)
    expect(summary.reduce((sum, s) => sum + s.count, 0)).toBe(5000)
    expect(summary[summary.length - 1].label).toBe(kf8.chunks.entries[4999].label)
  })
})
