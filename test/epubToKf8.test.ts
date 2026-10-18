import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { epubToKf8, type EpubToKf8Options } from '../src/main/epubConvert'
import { ConversionAbortError, EpubDrmError, EpubInvalidError } from '../src/main/epubConvert/errors'
import { writeKf8, type Kf8BookInput } from '../src/main/kf8'
import { JPEG, PNG, WEBP, writeEpubBook, type EpubBookSpec } from './setup/epubBookFixture'
import { readKf8 } from './setup/kf8Reader'

const ASIN = '0b9c2e5d-1a33-4a2d-8f77-3f6d9a1e1c4b'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-epub2kf8-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function convert(spec: EpubBookSpec, options: Partial<EpubToKf8Options> = {}): Promise<Kf8BookInput> {
  const file = writeEpubBook(path.join(dir, 'book.epub'), spec)
  return epubToKf8(file, { asin: ASIN, ...options })
}

/** The body text a kindle:pos link points at. */
function resolvePos(input: Kf8BookInput, href: string): string {
  const match = href.match(/^kindle:pos:fid:([0-9A-V]{4}):off:([0-9A-V]{10})$/)
  if (!match) throw new Error(`not a kindle:pos link: ${href}`)
  const body = Buffer.from(input.parts[parseInt(match[1], 32)].body, 'utf-8')
  return body.subarray(parseInt(match[2], 32)).toString('utf-8')
}

function hrefs(body: string): string[] {
  return [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
}

describe('epubToKf8 — content', () => {
  test('turns every spine document into a part, in reading order', async () => {
    const input = await convert({
      title: 'Il libro',
      author: 'Autrice',
      language: 'it-IT',
      docs: [
        { path: 'a.xhtml', title: 'Primo', body: '<h1>Uno</h1><p>alpha</p>' },
        { path: 'b.xhtml', title: 'Secondo', body: '<h1>Due</h1><p>beta</p>' }
      ]
    })

    expect(input.parts.map((p) => p.title)).toEqual(['Primo', 'Secondo'])
    expect(input.parts[0].body).toBe('<h1>Uno</h1><p>alpha</p>')
    expect(input.title).toBe('Il libro')
    expect(input.authors).toEqual(['Autrice'])
    expect(input.language).toBe('it-IT')
    expect(input.asin).toBe(ASIN)
    expect(input.parts[0].htmlAttributes).toEqual({ lang: 'it' })
  })

  test('lets the app override the title and author it stamps into the book', async () => {
    const input = await convert(
      { title: 'Vecchio', author: 'Vecchio Autore', docs: [{ path: 'a.xhtml', body: '<p>x</p>' }] },
      { title: 'Nuovo', author: 'Nuovo Autore' }
    )

    expect(input.title).toBe('Nuovo')
    expect(input.authors).toEqual(['Nuovo Autore'])
  })

  test('decodes HTML entities into characters and keeps markup well-formed', async () => {
    const input = await convert({
      docs: [{ path: 'a.xhtml', body: '<p>a&nbsp;b &amp; c &lt; d</p><br/><div></div><a id="x"/>Città' }]
    })

    expect(input.parts[0].body).toBe('<p>a b &amp; c &lt; d</p><br/><div></div><a id="x"></a>Città')
  })

  test('strips scripts, event handlers, namespaced attributes and comments', async () => {
    const input = await convert({
      docs: [
        {
          path: 'a.xhtml',
          body: '<script>alert(1)</script><p onclick="x()" epub:type="chapter" xml:lang="it" aid="9">t</p><!-- c --><iframe src="x"></iframe>'
        }
      ]
    })

    expect(input.parts[0].body).toBe('<p xml:lang="it">t</p>')
  })

  test('carries body attributes into the skeleton', async () => {
    const input = await convert({
      docs: [{ path: 'a.xhtml', body: '<p>x</p>', bodyAttrs: ' class="calibre" epub:type="bodymatter" dir="ltr"' }]
    })

    expect(input.parts[0].bodyAttributes).toEqual({ class: 'calibre', dir: 'ltr' })
  })

  test('falls back to the first heading, then the book title, for a part without <title>', async () => {
    const input = await convert({
      title: 'Libro',
      docs: [
        { path: 'a.xhtml', title: '', body: '<h2>Prologo</h2>' },
        { path: 'b.xhtml', title: '', body: '<p>nulla</p>' }
      ]
    })

    expect(input.parts.map((p) => p.title)).toEqual(['Prologo', 'Libro'])
  })
})

describe('epubToKf8 — links', () => {
  test('rewrites links between documents to kindle:pos links that land on the anchor', async () => {
    const input = await convert({
      docs: [
        { path: 'text/a.xhtml', body: '<p><a href="b.xhtml#sec">vai</a> <a href="#top">su</a> <a href="b.xhtml">inizio</a></p><p id="top">t</p>' },
        { path: 'text/b.xhtml', body: '<h1>Due</h1><p id="sec">sezione</p>' }
      ]
    })

    const [toSec, toTop, toStart] = hrefs(input.parts[0].body)
    expect(resolvePos(input, toSec).startsWith('<p id="sec">')).toBe(true)
    expect(resolvePos(input, toTop).startsWith('<p id="top">')).toBe(true)
    expect(resolvePos(input, toStart).startsWith('<h1>Due</h1>')).toBe(true)
  })

  test('keeps external links and drops links to files that are not in the book', async () => {
    const input = await convert({
      docs: [
        { path: 'a.xhtml', body: '<a href="https://example.com/x?a=1&amp;b=2">w</a><a href="missing.xhtml">m</a><a href="../../etc/passwd">p</a>' }
      ]
    })

    expect(input.parts[0].body).toBe('<a href="https://example.com/x?a=1&amp;b=2">w</a><a>m</a><a>p</a>')
  })

  test('targets an <a name> anchor and falls back to the part start for an unknown fragment', async () => {
    const input = await convert({
      docs: [
        { path: 'a.xhtml', body: '<a href="b.xhtml#n1">x</a><a href="b.xhtml#nope">y</a>' },
        { path: 'b.xhtml', body: '<p>intro</p><a name="n1"></a><p>dopo</p>' }
      ]
    })

    const [named, unknown] = hrefs(input.parts[0].body)
    expect(resolvePos(input, named).startsWith('<a name="n1">')).toBe(true)
    expect(resolvePos(input, unknown).startsWith('<p>intro</p>')).toBe(true)
  })
})

describe('epubToKf8 — images and stylesheets', () => {
  test('embeds supported images and removes the ones a Kindle cannot show', async () => {
    const input = await convert({
      docs: [{ path: 'a.xhtml', body: '<img src="img/a.jpg" alt="a"/><img src="img/b.webp"/><img src="img/none.png"/><img src="img/c.png" srcset="x 2x"/>' }],
      images: [
        { path: 'img/a.jpg', data: JPEG },
        { path: 'img/b.webp', data: WEBP },
        { path: 'img/c.png', data: PNG }
      ]
    })

    expect(input.parts[0].body).toBe(
      '<img src="kindle:embed:0001?mime=image/jpeg" alt="a"/><img src="kindle:embed:0002?mime=image/png"/>'
    )
    expect(input.images).toEqual([JPEG, PNG])
  })

  test('replaces an SVG cover wrapper with a plain image', async () => {
    const input = await convert({
      docs: [
        {
          path: 'cover.xhtml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 800"><image width="600" height="800" xlink:href="img/c.jpg"/></svg>'
        }
      ],
      images: [{ path: 'img/c.jpg', data: JPEG }]
    })

    expect(input.parts[0].body).toBe('<img src="kindle:embed:0001?mime=image/jpeg" alt=""/>')
  })

  test('turns linked and inline styles into shared CSS flows', async () => {
    const head = '<link rel="stylesheet" type="text/css" href="css/s.css"/><style>h1 { color: red }</style>'
    const input = await convert({
      docs: [
        { path: 'a.xhtml', head, body: '<h1>x</h1>' },
        { path: 'b.xhtml', head: '<link rel="stylesheet" href="css/s.css"/>', body: '<p>y</p>' }
      ],
      stylesheets: [
        {
          path: 'css/s.css',
          css: '@import url("other.css");\n@font-face { font-family: F; src: url(../fonts/f.ttf) }\np { background: url(../img/bg.png) }'
        }
      ],
      images: [{ path: 'img/bg.png', data: PNG }]
    })

    expect(input.stylesheets).toHaveLength(2)
    expect(input.parts[0].stylesheets).toEqual([1, 2])
    expect(input.parts[1].stylesheets).toEqual([1])
    expect(input.stylesheets[0]).not.toMatch(/@import|@font-face/)
    expect(input.stylesheets[0]).toContain('url(kindle:embed:0001?mime=image/png)')
    expect(input.stylesheets[1]).toBe('h1 { color: red }')
  })
})

describe('epubToKf8 — navigation', () => {
  test('reads the EPUB3 nav document into TOC entries with part and offset', async () => {
    const input = await convert({
      docs: [
        { path: 'a.xhtml', body: '<h1>Uno</h1>' },
        { path: 'b.xhtml', body: '<p>x</p><h2 id="s2">Sezione</h2>' }
      ],
      nav: '<li><a href="a.xhtml">Capitolo  uno</a><ol><li><a href="b.xhtml#s2">Sezione <span>due</span></a></li></ol></li>'
    })

    expect(input.toc.map((e) => [e.title, e.part])).toEqual([
      ['Capitolo uno', 0],
      ['Sezione due', 1]
    ])
    const body = Buffer.from(input.parts[1].body)
    expect(body.subarray(input.toc[1].offset).toString().startsWith('<h2 id="s2">')).toBe(true)
  })

  test('reads an EPUB2 NCX when there is no nav document', async () => {
    const input = await convert({
      docs: [{ path: 'a.xhtml', body: '<h1>Uno</h1>' }, { path: 'b.xhtml', body: '<h1>Due</h1>' }],
      ncx:
        '<navPoint id="n1"><navLabel><text>Uno</text></navLabel><content src="a.xhtml"/>' +
        '<navPoint id="n2"><navLabel><text>Due &amp; mezzo</text></navLabel><content src="b.xhtml"/></navPoint></navPoint>'
    })

    expect(input.toc.map((e) => [e.title, e.part, e.offset])).toEqual([
      ['Uno', 0, 0],
      ['Due & mezzo', 1, 0]
    ])
  })

  test('leaves the TOC empty when the book has none, so the writer derives one', async () => {
    const input = await convert({ docs: [{ path: 'a.xhtml', body: '<p>x</p>' }] })

    expect(input.toc).toEqual([])
  })
})

describe('epubToKf8 — cover', () => {
  test('uses the cover the app supplies, plus its thumbnail', async () => {
    const thumbnail = Buffer.from('thumb')
    const input = await convert(
      { docs: [{ path: 'a.xhtml', body: '<p>x</p>' }] },
      { cover: PNG, thumbnail: () => thumbnail }
    )

    expect(input.images).toEqual([PNG])
    expect(input.cover).toEqual({ image: 0, thumbnail })
  })

  test("falls back to the EPUB's own cover image and reuses it when it is also in the text", async () => {
    const input = await convert({
      docs: [{ path: 'a.xhtml', body: '<img src="img/c.jpg"/>' }],
      images: [{ path: 'img/c.jpg', data: JPEG, cover: true }]
    })

    expect(input.images).toEqual([JPEG])
    expect(input.cover?.image).toBe(0)
  })

  test('ignores a supplied cover that is not an image', async () => {
    const input = await convert({ docs: [{ path: 'a.xhtml', body: '<p>x</p>' }] }, { cover: Buffer.from('nope') })

    expect(input.cover).toBeUndefined()
  })
})

describe('epubToKf8 — failures', () => {
  test('rejects a file that is not a ZIP', async () => {
    const file = path.join(dir, 'bad.epub')
    writeFileSync(file, 'not a zip at all')

    await expect(epubToKf8(file, { asin: ASIN })).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('rejects an EPUB without readable content documents', async () => {
    await expect(convert({ docs: [] })).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('rejects DRM-encrypted content but accepts obfuscated fonts', async () => {
    const encryption = (algorithm: string): string =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="OEBPS/a.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`
    const docs = [{ path: 'a.xhtml', body: '<p>x</p>' }]

    await expect(
      convert({ docs, encryption: encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc') })
    ).rejects.toBeInstanceOf(EpubDrmError)
    await expect(
      convert({ docs, encryption: encryption('http://www.idpf.org/2008/embedding') })
    ).resolves.toBeDefined()
  })

  test('rejects an archive entry above the size limit', async () => {
    await expect(
      convert({ docs: [{ path: 'a.xhtml', body: `<p>${'x'.repeat(5000)}</p>` }] }, { limits: { maxEntryBytes: 1000 } })
    ).rejects.toBeInstanceOf(EpubInvalidError)
  })

  test('stops with an AbortError when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()

    const error = await convert({ docs: [{ path: 'a.xhtml', body: '<p>x</p>' }] }, { signal: controller.signal }).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(ConversionAbortError)
    expect((error as Error).name).toBe('AbortError')
  })

  test('reports progress up to 100%', async () => {
    const seen: number[] = []
    await convert(
      { docs: [{ path: 'a.xhtml', body: '<p>a</p>' }, { path: 'b.xhtml', body: '<p>b</p>' }] },
      { onProgress: (p) => seen.push(p) }
    )

    expect(seen[seen.length - 1]).toBe(100)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })
})

describe('epubToKf8 → writeKf8', () => {
  test('produces a book whose reassembled parts carry the content and a working link', async () => {
    const input = await convert({
      title: 'Completo',
      docs: [
        { path: 'a.xhtml', body: '<p><a href="b.xhtml#sec">vai</a></p>' },
        { path: 'b.xhtml', body: '<p>prima</p><p id="sec">Città</p>' }
      ],
      nav: '<li><a href="a.xhtml">A</a></li><li><a href="b.xhtml#sec">B</a></li>'
    })

    const kf8 = readKf8(writeKf8(input))

    expect(kf8.parts[1]).toContain('<p id="sec">Città</p>')
    const titles = kf8.ncx.entries.map((e) => kf8.ncx.cncx.get(e.tags[3][0]))
    expect(titles).toEqual(['A', 'B'])
  })
})

describe('epubToKf8 — document identity', () => {
  test('an anchor written as ID= is a link target', async () => {
    const input = await convert({
      docs: [
        { path: 'a.xhtml', body: '<a href="b.xhtml#t">t</a>' },
        { path: 'b.xhtml', body: '<p>pad</p><h2 ID="t">Target</h2>' }
      ]
    })

    const [href] = hrefs(input.parts[0].body)
    expect(resolvePos(input, href)).toMatch(/^<h2 id="t">Target/)
  })

  test('a document listed more than once in the spine becomes one part', async () => {
    const input = await convert({
      docs: [
        { path: 'a.xhtml', body: '<p>a</p>' },
        { path: 'b.xhtml', body: '<p>b</p>' }
      ],
      spine: ['a.xhtml', 'a.xhtml', 'b.xhtml', 'a.xhtml']
    })

    expect(input.parts.map((p) => p.body)).toEqual(['<p>a</p>', '<p>b</p>'])
  })
})
