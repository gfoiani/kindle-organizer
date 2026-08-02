import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import './setup/electron-mock' // stubs `electron` so epub.ts can import `app`
import { parseEpub } from '../src/main/epub'
import { buildEpub, fakeJpeg, writeEpub } from './setup/epubFixture'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-epub-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseEpub — metadata', () => {
  test('extracts title and author from a well-formed EPUB', async () => {
    // Arrange
    const file = writeEpub(path.join(dir, 'book.epub'), {
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin'
    })

    // Act
    const meta = await parseEpub(file)

    // Assert
    expect(meta.title).toBe('The Left Hand of Darkness')
    expect(meta.author).toBe('Ursula K. Le Guin')
  })

  test('omits author when the OPF has no dc:creator', async () => {
    const file = writeEpub(path.join(dir, 'book.epub'), { title: 'Anonymous Work' })

    const meta = await parseEpub(file)

    expect(meta.title).toBe('Anonymous Work')
    expect(meta.author).toBeUndefined()
  })
})

describe('parseEpub — cover extraction', () => {
  test('extracts the embedded cover (EPUB3 properties="cover-image")', async () => {
    // Arrange
    const cover = fakeJpeg(900)
    const file = writeEpub(path.join(dir, 'book.epub'), {
      title: 'With Cover',
      cover,
      coverStyle: 'epub3'
    })

    // Act
    const meta = await parseEpub(file)

    // Assert
    expect(meta.coverImage).toBeInstanceOf(Buffer)
    expect(meta.coverImage?.equals(cover)).toBe(true)
  })

  test('extracts the cover via the EPUB2 <meta name="cover"> style', async () => {
    const cover = fakeJpeg(700)
    const file = writeEpub(path.join(dir, 'book.epub'), {
      title: 'Legacy Cover',
      cover,
      coverStyle: 'epub2'
    })

    const meta = await parseEpub(file)

    expect(meta.coverImage?.equals(cover)).toBe(true)
  })

  test('returns no coverImage when the EPUB has no cover', async () => {
    const file = writeEpub(path.join(dir, 'book.epub'), { title: 'Coverless' })

    const meta = await parseEpub(file)

    expect(meta.coverImage).toBeUndefined()
  })
})

describe('parseEpub — graceful degradation', () => {
  test('degrades to a filename title when META-INF/container.xml is missing', async () => {
    const file = writeEpub(path.join(dir, 'My_Great_Book.epub'), {
      title: 'Ignored',
      omitContainer: true
    })

    const meta = await parseEpub(file)

    // Title comes from the filename (underscores → spaces, extension stripped).
    expect(meta.title).toBe('My Great Book')
    expect(meta.coverImage).toBeUndefined()
  })

  test('degrades to a filename title when the OPF is malformed', async () => {
    const file = writeEpub(path.join(dir, 'Broken_Opf.epub'), {
      title: 'Ignored',
      malformedOpf: true
    })

    const meta = await parseEpub(file)

    expect(meta.title).toBe('Broken Opf')
  })

  test('throws when the file is not a readable ZIP archive', async () => {
    // Arrange — a .epub that is not a zip at all.
    const file = path.join(dir, 'corrupt.epub')
    writeFileSync(file, Buffer.from('this is definitely not a zip archive'))

    // Act + Assert
    await expect(parseEpub(file)).rejects.toThrow()
  })
})

describe('parseEpub — fixture builder self-check', () => {
  test('buildEpub produces a non-empty archive that round-trips', async () => {
    const buf = buildEpub({ title: 'Roundtrip' })
    const file = path.join(dir, 'roundtrip.epub')
    writeFileSync(file, buf)

    const meta = await parseEpub(file)

    expect(buf.length).toBeGreaterThan(0)
    expect(meta.title).toBe('Roundtrip')
  })
})
