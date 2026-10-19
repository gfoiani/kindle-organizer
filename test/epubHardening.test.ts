import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { crc32, deflateRawSync } from 'zlib'
import { epubToKf8 } from '../src/main/epubConvert'
import { sanitizeCss } from '../src/main/epubConvert/css'
import { EpubInvalidError } from '../src/main/epubConvert/errors'
import { writeEpubBook, xhtml, type EpubBookSpec } from './setup/epubBookFixture'
import { fakeJpeg } from './setup/epubFixture'

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

describe('HTML is normalized to XHTML', () => {
  test('uppercase tags and attribute names come out lowercase, keeping the text after <BR>', async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<P CLASS="x">a<BR>b</P>' }] })

    expect(body).toBe('<p class="x">a<br/>b</p>')
  })

  test('an uppercase HREF is vetted like a lowercase one', async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<a HREF="javascript:alert(1)">x</a>' }] })

    expect(body).toBe('<a>x</a>')
  })

  test('SVG keeps its case-sensitive names', async () => {
    const body = await convert({
      docs: [{ path: 'a.xhtml', body: '<svg viewBox="0 0 1 1"><linearGradient id="g"></linearGradient><rect/></svg>' }]
    })

    expect(body).toContain('viewBox="0 0 1 1"')
    expect(body).toContain('<linearGradient id="g"/>')
  })

  test('a legacy chapter of unclosed uppercase <P> converts flat instead of being refused as too deep', async () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `<P>p${i}`).join('')

    const body = await convert({ docs: [{ path: 'a.xhtml', body: paragraphs }] })

    expect(body.startsWith('<p>p0</p><p>p1</p><p>p2</p>')).toBe(true)
  })

  test('unclosed uppercase list items close each other like lowercase ones', async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<UL><LI>a<LI>b</UL>' }] })

    expect(body).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  test('camelCase SVG element names survive, whatever case the source used', async () => {
    const body = await convert({
      docs: [{ path: 'a.xhtml', body: '<svg><clipPath id="c"></clipPath><FOREIGNOBJECT></FOREIGNOBJECT></svg>' }]
    })

    expect(body).toContain('<clipPath id="c"/>')
    expect(body).toContain('<foreignObject/>')
  })

  test('URL attributes outside <img> are dropped, not left as broken references', async () => {
    const body = await convert({
      docs: [
        {
          path: 'a.xhtml',
          body: '<picture><source srcset="http://e.example/a.jpg"/></picture><input type="image" src="http://e.example/b.png"/>'
        }
      ]
    })

    expect(body).not.toContain('e.example')
  })
})

describe('size and count limits', () => {
  const MiB = 1024 * 1024

  async function book(spec: EpubBookSpec): Promise<Awaited<ReturnType<typeof epubToKf8>>> {
    return epubToKf8(writeEpubBook(path.join(dir, 'b.epub'), spec), { asin: ASIN })
  }

  test('refuses a content document over 8 MiB: parsing it would freeze the app for seconds', async () => {
    const body = `<p>${'x'.repeat(8.5 * MiB)}</p>`

    await expect(book({ docs: [{ path: 'a.xhtml', body }] })).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('refuses a package document (OPF) over 4 MiB', async () => {
    await expect(
      book({ title: 'x'.repeat(5 * MiB), docs: [{ path: 'a.xhtml', body: '<p>a</p>' }] })
    ).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('cuts an enormous title and author down to a sane length', async () => {
    const input = await book({
      title: 'T'.repeat(100_000),
      author: 'A'.repeat(100_000),
      docs: [{ path: 'a.xhtml', body: '<p>a</p>' }]
    })

    expect(input.title.length).toBeLessThanOrEqual(512)
    expect(input.authors.every((author) => author.length <= 512)).toBe(true)
  })

  test('keeps at most 10,000 table-of-contents entries', async () => {
    const links = Array.from({ length: 10_050 }, (_, i) => `<li><a href="a.xhtml">Chapter ${i}</a></li>`).join('')

    const input = await book({ docs: [{ path: 'a.xhtml', body: '<p>a</p>' }], nav: `<ol>${links}</ol>` })

    expect(input.toc).toHaveLength(10_000)
  })

  test('ignores a navigation document over 4 MiB, as it would any unreadable TOC', async () => {
    const padding = `<!-- ${'x'.repeat(5 * MiB)} -->`

    const input = await book({
      docs: [{ path: 'a.xhtml', body: '<p>a</p>' }],
      nav: `<ol><li><a href="a.xhtml">One</a></li></ol>${padding}`
    })

    expect(input.toc).toEqual([])
  })
})

describe('namespaces the output does not declare', () => {
  test("unwraps prefixed elements such as Word's <o:p>, keeping their text", async () => {
    const body = await convert({ docs: [{ path: 'a.xhtml', body: '<p>Uno<o:p>due</o:p></p>' }] })

    expect(body).not.toContain('o:p')
    expect(body).toContain('Unodue')
  })

  test('drops xlink attributes outside SVG', async () => {
    const body = await convert({
      docs: [{ path: 'a.xhtml', body: '<p><a id="x" xlink:href="http://example.com/">link</a></p>' }]
    })

    expect(body).not.toContain('xlink:')
  })

  test('declares the SVG and xlink namespaces on an SVG whose image it points at the book', async () => {
    const svg =
      '<svg viewBox="0 0 10 10"><rect width="1" height="1"/><image width="10" height="10" href="img/c.jpg"/></svg>'

    const body = await convert({
      docs: [{ path: 'a.xhtml', body: svg }],
      images: [{ path: 'img/c.jpg', data: fakeJpeg() }]
    })

    expect(body).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(body).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
    expect(body).toContain('xlink:href="kindle:embed:')
  })
})
