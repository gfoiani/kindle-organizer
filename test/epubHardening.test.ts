import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { crc32, deflateRawSync } from 'zlib'
import { epubToKf8 } from '../src/main/epubConvert'
import { sanitizeCss } from '../src/main/epubConvert/css'
import { EpubInvalidError } from '../src/main/epubConvert/errors'
import { writeEpubBook, xhtml, type EpubBookSpec } from './setup/epubBookFixture'

/**
 * Hostile-input cases from the security review: zip bombs that lie about their
 * size, pathological CSS, absurd nesting, and markup that would corrupt the
 * XHTML the Kindle has to parse.
 */

const ASIN = 'hardening-test'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-hardening-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function convert(spec: EpubBookSpec): Promise<string> {
  const input = await epubToKf8(writeEpubBook(path.join(dir, 'b.epub'), spec), { asin: ASIN })
  return input.parts[0].body
}

interface RawEntry {
  name: string
  data: Buffer
  deflate?: boolean
  /** Uncompressed size to declare (a zip bomb lies here). */
  declaredSize?: number
  /** General-purpose flags; bit 3 makes node-stream-zip skip its size check. */
  flags?: number
}

/** A ZIP whose entries can be deflated and can lie about their size. */
function buildZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    const size = e.declaredSize ?? e.data.length
    const crc = crc32(e.data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.flags ?? 0, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.flags ?? 0, 8)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('archive limits', () => {
  test('counts the bytes an entry really inflates to, not the size it declares', async () => {
    // Arrange: 4 MiB of text that claims to be 100 bytes, with bit 3 set.
    const bomb = Buffer.from(xhtml(`<p>${'a'.repeat(4 * 1024 * 1024)}</p>`))
    const file = path.join(dir, 'bomb.epub')
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>B</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`
    writeFileSync(
      file,
      buildZip([
        { name: 'mimetype', data: Buffer.from('application/epub+zip') },
        {
          name: 'META-INF/container.xml',
          data: Buffer.from(
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'
          )
        },
        { name: 'content.opf', data: Buffer.from(opf) },
        { name: 'a.xhtml', data: bomb, deflate: true, declaredSize: 100, flags: 0x08 }
      ])
    )

    // Act + Assert
    await expect(
      epubToKf8(file, { asin: ASIN, limits: { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 } })
    ).rejects.toBeInstanceOf(EpubInvalidError)
  })
})

describe('CSS sanitizing stays linear on hostile input', () => {
  const noImages = (): undefined => undefined

  test('unterminated @font-face blocks', () => {
    const start = performance.now()
    sanitizeCss('@font-face{'.repeat(40000), 'a.css', noImages)
    expect(performance.now() - start).toBeLessThan(500)
  })

  test('url( followed by endless whitespace', () => {
    const start = performance.now()
    sanitizeCss(`p { background: url(${' '.repeat(200000)}`, 'a.css', noImages)
    expect(performance.now() - start).toBeLessThan(500)
  })

  test('a character whose lowercase form is longer does not shift the rewrite', () => {
    // Arrange: 'İ' (U+0130) lowercases to two UTF-16 code units.
    const resolve = (p: string): string | undefined => (p === 'img.png' ? 'kindle:embed:0001' : undefined)
    const fonts = 'h1{content:"İİİİ"} @font-face{font-family:x;src:url(a.ttf)} p{color:red}'
    const urls = 'h1{content:"İİ"} p{background:url(img.png)}'
    const imports = 'h1{content:"İİ"} @import "x.css"; p{color:red}'

    // Act + Assert
    expect(sanitizeCss(fonts, 'a.css', noImages)).toBe('h1{content:"İİİİ"}  p{color:red}')
    expect(sanitizeCss(urls, 'a.css', resolve)).toBe('h1{content:"İİ"} p{background:url(kindle:embed:0001)}')
    expect(sanitizeCss(imports, 'a.css', noImages)).toBe('h1{content:"İİ"}  p{color:red}')
  })

  test('still drops font faces and rewrites quoted and bare urls', () => {
    const css = sanitizeCss(
      `@font-face { src: url(f.ttf) } a { b: url( "img/x.png" ) } c { d: url('img/x.png') } e { f: url(img/x.png) } g { h: url(none.png) }`,
      'css/s.css',
      (p) => (p === 'css/img/x.png' ? 'kindle:embed:0001?mime=image/png' : undefined)
    )
    expect(css).toBe(
      'a { b: url(kindle:embed:0001?mime=image/png) } c { d: url(kindle:embed:0001?mime=image/png) } e { f: url(kindle:embed:0001?mime=image/png) } g { h: url(none.png) }'
    )
  })
})

describe('markup that would corrupt the produced XHTML', () => {
  test('rejects absurdly deep nesting as an invalid EPUB instead of overflowing the stack', async () => {
    const deep = '<div>'.repeat(20000) + 'x' + '</div>'.repeat(20000)

    await expect(convert({ docs: [{ path: 'a.xhtml', body: deep }] })).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('unwraps elements whose names are not valid XML names', async () => {
    expect(await convert({ docs: [{ path: 'a.xhtml', body: '<p<b>t</p<b>' }] })).toBe('t')
  })

  test('strips control characters from text and attributes', async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<p title="a\u0001b">x\u0002y</p>' }] })

    expect(body).toBe('<p title="ab">xy</p>')
  })

  test('drops links inside SVG instead of passing their targets through', async () => {
    const body = await convert({
      docs: [
        {
          path: 'a.xhtml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="file:///etc/passwd"><text>t</text></a></svg>'
        }
      ]
    })

    expect(body).not.toContain('file:')
  })

  test('keeps text that happens to look like an internal link placeholder', async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<p>kindle:pos:fid:zzzz:off:zzzzzzzzzz</p>' }] })

    expect(body).toBe('<p>kindle:pos:fid:zzzz:off:zzzzzzzzzz</p>')
  })
})

describe('encodings', () => {
  test('decodes a UTF-16 content document', async () => {
    const source = '﻿' + xhtml('<p>Città</p>').replace('encoding="utf-8"', 'encoding="utf-16"')

    const body = await convert({ docs: [{ path: 'a.xhtml', body: '', raw: Buffer.from(source, 'utf16le') }] })

    expect(body).toBe('<p>Città</p>')
  })
})
