import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import './setup/electron-mock' // nativeImage stub → toKindleJpeg falls back to raw bytes
import { writeMobi } from './setup/mobiFixture'
import { fakeJpeg } from './setup/epubFixture'
import { thumbnailFilename, writeKindleThumbnail } from '../src/main/kindleThumbnails'

const UUID = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

let mountpoint: string
let books: string

function thumbnailsDir(): string {
  return path.join(mountpoint, 'system', 'thumbnails')
}

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
  books = mkdtempSync(path.join(tmpdir(), 'kindle-books-'))
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
  rmSync(books, { recursive: true, force: true })
})

describe('thumbnailFilename', () => {
  test('matches the name calibre gives a Kindle cover thumbnail', () => {
    expect(thumbnailFilename({ asin: UUID, cdetype: 'EBOK' })).toBe(
      `thumbnail_${UUID}_EBOK_portrait.jpg`
    )
  })
})

describe('writeKindleThumbnail', () => {
  test('writes the cover under system/thumbnails, named after the book identifiers', async () => {
    // Arrange
    const book = writeMobi(path.join(books, 'converted.azw3'), { uuid: UUID, cdetype: 'EBOK' })
    const cover = fakeJpeg()
    mkdirSync(thumbnailsDir(), { recursive: true })

    // Act
    const written = await writeKindleThumbnail(mountpoint, book, cover)

    // Assert
    expect(written).toBe(`thumbnail_${UUID}_EBOK_portrait.jpg`)
    expect(readFileSync(path.join(thumbnailsDir(), written!))).toEqual(cover)
  })

  test('creates system/thumbnails when the device does not have it yet', async () => {
    const book = writeMobi(path.join(books, 'converted.azw3'), { uuid: UUID })
    expect(existsSync(thumbnailsDir())).toBe(false)

    const written = await writeKindleThumbnail(mountpoint, book, fakeJpeg())

    expect(written).not.toBeNull()
    expect(existsSync(path.join(thumbnailsDir(), written!))).toBe(true)
  })

  test('replaces an existing thumbnail and leaves no temp file behind', async () => {
    const book = writeMobi(path.join(books, 'converted.azw3'), { uuid: UUID, cdetype: 'EBOK' })
    const name = `thumbnail_${UUID}_EBOK_portrait.jpg`
    mkdirSync(thumbnailsDir(), { recursive: true })
    writeFileSync(path.join(thumbnailsDir(), name), Buffer.from('stale'))

    const fresh = fakeJpeg()
    await writeKindleThumbnail(mountpoint, book, fresh)

    expect(readFileSync(path.join(thumbnailsDir(), name))).toEqual(fresh)
    expect(readdirSync(thumbnailsDir())).toEqual([name])
  })

  test('skips a book with no readable identifiers (e.g. a PDF) without writing anything', async () => {
    const pdf = path.join(books, 'manual.pdf')
    writeFileSync(pdf, Buffer.from('%PDF-1.7'))

    const written = await writeKindleThumbnail(mountpoint, pdf, fakeJpeg())

    expect(written).toBeNull()
    expect(existsSync(thumbnailsDir())).toBe(false)
  })

  test('skips an empty cover buffer (the cover cache uses 0 bytes as "no cover")', async () => {
    const book = writeMobi(path.join(books, 'converted.azw3'), { uuid: UUID })

    const written = await writeKindleThumbnail(mountpoint, book, Buffer.alloc(0))

    expect(written).toBeNull()
    expect(existsSync(thumbnailsDir())).toBe(false)
  })

  test('resolves null instead of throwing when the device is gone mid-write', async () => {
    const book = writeMobi(path.join(books, 'converted.azw3'), { uuid: UUID })
    rmSync(mountpoint, { recursive: true, force: true })
    // A file where the mountpoint should be: every write under it must fail.
    writeFileSync(mountpoint, Buffer.from('not a directory'))

    await expect(writeKindleThumbnail(mountpoint, book, fakeJpeg())).resolves.toBeNull()
  })
})
