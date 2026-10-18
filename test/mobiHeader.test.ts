import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildMobi, writeMobi } from './setup/mobiFixture'
import { parseMobiIdentifiers, readMobiIdentifiers } from '../src/main/mobiHeader'

const UUID = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kindle-mobi-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseMobiIdentifiers', () => {
  test('reads the calibre-written UUID and cdetype out of the EXTH block', () => {
    // Arrange
    const file = buildMobi({ uuid: UUID, cdetype: 'EBOK' })

    // Act
    const ids = parseMobiIdentifiers(file)

    // Assert
    expect(ids).toEqual({ asin: UUID, cdetype: 'EBOK' })
  })

  test('prefers a real ASIN (EXTH 504) over the UUID (EXTH 113)', () => {
    const file = buildMobi({ uuid: UUID, asin: 'B00EXAMPLE', cdetype: 'EBOK' })

    expect(parseMobiIdentifiers(file)?.asin).toBe('B00EXAMPLE')
  })

  test('defaults the cdetype to EBOK when EXTH 501 is absent', () => {
    const file = buildMobi({ uuid: UUID })

    expect(parseMobiIdentifiers(file)).toEqual({ asin: UUID, cdetype: 'EBOK' })
  })

  test('keeps a personal-document cdetype as-is', () => {
    const file = buildMobi({ uuid: UUID, cdetype: 'PDOC' })

    expect(parseMobiIdentifiers(file)?.cdetype).toBe('PDOC')
  })

  test('ignores EXTH records it does not care about', () => {
    const file = buildMobi({
      uuid: UUID,
      cdetype: 'EBOK',
      extraExth: [
        [100, 'Frank Herbert'],
        [503, 'Dune']
      ]
    })

    expect(parseMobiIdentifiers(file)).toEqual({ asin: UUID, cdetype: 'EBOK' })
  })

  test('returns null when the book carries no identifier at all', () => {
    const file = buildMobi({ cdetype: 'EBOK' })

    expect(parseMobiIdentifiers(file)).toBeNull()
  })

  test('returns null when the file has no EXTH block', () => {
    const file = buildMobi({ uuid: UUID, withoutExth: true })

    expect(parseMobiIdentifiers(file)).toBeNull()
  })

  test('returns null for a PalmDB that is not a MOBI/AZW3', () => {
    const file = buildMobi({ uuid: UUID, typeCreator: 'TEXtREAd' })

    expect(parseMobiIdentifiers(file)).toBeNull()
  })

  test('returns null for arbitrary non-PalmDB bytes (e.g. a PDF)', () => {
    expect(parseMobiIdentifiers(Buffer.from('%PDF-1.7\nnot a palm database at all'))).toBeNull()
    expect(parseMobiIdentifiers(Buffer.alloc(0))).toBeNull()
  })

  test('returns null for a truncated file instead of throwing', () => {
    const file = buildMobi({ uuid: UUID, cdetype: 'EBOK' })

    expect(() => parseMobiIdentifiers(file.subarray(0, 100))).not.toThrow()
    expect(parseMobiIdentifiers(file.subarray(0, 100))).toBeNull()
  })

  test('rejects an identifier that is not filename-safe (no path traversal)', () => {
    const file = buildMobi({ uuid: '../../system/evil', cdetype: 'EBOK' })

    expect(parseMobiIdentifiers(file)).toBeNull()
  })

  test('rejects a cdetype that is not filename-safe', () => {
    const file = buildMobi({ uuid: UUID, cdetype: '../x' })

    expect(parseMobiIdentifiers(file)).toBeNull()
  })
})

describe('readMobiIdentifiers', () => {
  test('reads the identifiers from a file on disk', async () => {
    const file = writeMobi(path.join(dir, 'book.azw3'), { uuid: UUID, cdetype: 'EBOK' })

    await expect(readMobiIdentifiers(file)).resolves.toEqual({ asin: UUID, cdetype: 'EBOK' })
  })

  test('resolves null for a non-MOBI file rather than throwing', async () => {
    const file = path.join(dir, 'doc.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.7'))

    await expect(readMobiIdentifiers(file)).resolves.toBeNull()
  })

  test('resolves null when the file does not exist', async () => {
    await expect(readMobiIdentifiers(path.join(dir, 'missing.azw3'))).resolves.toBeNull()
  })
})
