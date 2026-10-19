import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { deleteDeviceBooks } from '../src/main/deviceDelete'
import { getThumbnailDir, thumbnailFilename } from '../src/main/kindleThumbnails'
import { writeMobi } from './setup/mobiFixture'

const UUID = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

let mountpoint: string
const documents = (...parts: string[]): string => path.join(mountpoint, 'documents', ...parts)

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-delete-'))
  mkdirSync(documents('A'), { recursive: true })
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
})

describe('deleteDeviceBooks', () => {
  test('removes the book, its .sdr reading data, its thumbnail and its metadata.calibre record', async () => {
    // Arrange
    const book = writeMobi(documents('A', 'Book.azw3'), { uuid: UUID, cdetype: 'EBOK' })
    mkdirSync(documents('A', 'Book.sdr'))
    writeFileSync(documents('A', 'Book.sdr', 'Book.sdr.json'), '{}')
    const thumbnail = path.join(getThumbnailDir(mountpoint), thumbnailFilename({ asin: UUID, cdetype: 'EBOK' }))
    mkdirSync(getThumbnailDir(mountpoint), { recursive: true })
    writeFileSync(thumbnail, 'jpg')
    const other = writeMobi(documents('Other.azw3'), { uuid: 'other', cdetype: 'EBOK' })
    writeFileSync(
      path.join(mountpoint, 'metadata.calibre'),
      JSON.stringify([{ lpath: 'documents/A/Book.azw3' }, { lpath: 'documents/Other.azw3' }])
    )

    // Act
    const result = await deleteDeviceBooks(mountpoint, [book])

    // Assert
    expect(result).toEqual({ deleted: [book], failed: [] })
    expect(existsSync(book)).toBe(false)
    expect(existsSync(documents('A', 'Book.sdr'))).toBe(false)
    expect(existsSync(thumbnail)).toBe(false)
    expect(existsSync(other)).toBe(true)
    const records = JSON.parse(readFileSync(path.join(mountpoint, 'metadata.calibre'), 'utf-8'))
    expect(records).toEqual([{ lpath: 'documents/Other.azw3' }])
  })

  test('keeps the thumbnail while another copy of the book on the device still shows it', async () => {
    // Arrange: two copies of one book (same identifier), both registered in metadata.calibre.
    const copy = writeMobi(documents('Book.azw3'), { uuid: UUID, cdetype: 'EBOK' })
    writeMobi(documents('Book (2).azw3'), { uuid: UUID, cdetype: 'EBOK' })
    const thumbnail = path.join(getThumbnailDir(mountpoint), thumbnailFilename({ asin: UUID, cdetype: 'EBOK' }))
    mkdirSync(getThumbnailDir(mountpoint), { recursive: true })
    writeFileSync(thumbnail, 'jpg')
    writeFileSync(
      path.join(mountpoint, 'metadata.calibre'),
      JSON.stringify([
        { lpath: 'documents/Book.azw3', uuid: UUID },
        { lpath: 'documents/Book (2).azw3', uuid: UUID }
      ])
    )

    // Act
    await deleteDeviceBooks(mountpoint, [copy])

    // Assert
    expect(existsSync(thumbnail)).toBe(true)
  })

  test('refuses anything outside documents/ or that is not a book, deleting nothing', async () => {
    const outside = path.join(mountpoint, 'system', 'Book.azw3')
    mkdirSync(path.dirname(outside), { recursive: true })
    writeFileSync(outside, '')
    const escaping = documents('..', 'system', 'Book.azw3')
    const notABook = documents('notes.txt')
    writeFileSync(notABook, '')

    const result = await deleteDeviceBooks(mountpoint, [outside, escaping, notABook])

    expect(result).toEqual({ deleted: [], failed: [outside, escaping, notABook] })
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(notABook)).toBe(true)
  })

  test('does not follow a symbolic link out of the device', async () => {
    const target = path.join(mkdtempSync(path.join(tmpdir(), 'kindle-outside-')), 'Real.azw3')
    writeFileSync(target, 'precious')
    const link = documents('Link.azw3')
    symlinkSync(target, link)

    const result = await deleteDeviceBooks(mountpoint, [link])

    expect(result.failed).toEqual([link])
    expect(readFileSync(target, 'utf-8')).toBe('precious')
    rmSync(path.dirname(target), { recursive: true, force: true })
  })

  test('keeps the .sdr folder that another book with the same name still uses', async () => {
    // Arrange: the Kindle names reading data by stem, so Book.azw3 and Book.pdf share Book.sdr.
    const azw3 = writeMobi(documents('A', 'Book.azw3'), { uuid: UUID })
    writeFileSync(documents('A', 'Book.pdf'), '%PDF')
    mkdirSync(documents('A', 'Book.sdr'))

    // Act
    await deleteDeviceBooks(mountpoint, [azw3])

    // Assert
    expect(existsSync(documents('A', 'Book.sdr'))).toBe(true)
  })

  test('refuses a book reached through a folder that links off the device', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'kindle-outside-'))
    const target = path.join(outsideDir, 'Real.azw3')
    writeFileSync(target, 'precious')
    symlinkSync(outsideDir, documents('Linked'))
    const viaLink = documents('Linked', 'Real.azw3')

    const result = await deleteDeviceBooks(mountpoint, [viaLink])

    expect(result.failed).toEqual([viaLink])
    expect(readFileSync(target, 'utf-8')).toBe('precious')
    rmSync(outsideDir, { recursive: true, force: true })
  })

  test('reports a book that is already gone and carries on with the rest', async () => {
    const missing = documents('Missing.azw3')
    const present = writeMobi(documents('Present.azw3'), { uuid: UUID })

    const result = await deleteDeviceBooks(mountpoint, [missing, present])

    expect(result).toEqual({ deleted: [present], failed: [missing] })
  })
})
