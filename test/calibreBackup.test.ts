import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  CALIBRE_BACKUP_LIMIT,
  removeCalibreEntries,
  restoreCalibreBackup,
  writeCalibreMetadata
} from '../src/main/calibre'

let mountpoint: string

const backupDir = (): string => path.join(mountpoint, '.kindle-organizer', 'backups')
const metadataPath = (): string => path.join(mountpoint, 'metadata.calibre')

function writeMetadata(entries: unknown): string {
  const text = JSON.stringify(entries)
  writeFileSync(metadataPath(), text, 'utf-8')
  return text
}

function readMetadata(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(metadataPath(), 'utf-8'))
}

function backups(): string[] {
  return existsSync(backupDir()) ? readdirSync(backupDir()).sort() : []
}

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-backup-'))
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
})

describe('metadata.calibre backups', () => {
  test('keeps a copy of the previous file before overwriting it', () => {
    // Arrange
    const before = writeMetadata([{ lpath: 'documents/A.azw3', tags: ['Old'] }])

    // Act
    writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['New']]]))

    // Assert
    const [copy] = backups()
    expect(backups()).toHaveLength(1)
    expect(readFileSync(path.join(backupDir(), copy), 'utf-8')).toBe(before)
  })

  test('makes no backup when there was no file to overwrite', () => {
    writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['X']]]), [{ relpath: 'A.azw3', title: 'A', size: 1 }])

    expect(existsSync(metadataPath())).toBe(true)
    expect(backups()).toEqual([])
  })

  test(`keeps only the ${CALIBRE_BACKUP_LIMIT} most recent copies`, () => {
    writeMetadata([{ lpath: 'documents/A.azw3', tags: [] }])

    for (let i = 0; i < CALIBRE_BACKUP_LIMIT + 3; i++) {
      writeCalibreMetadata(mountpoint, new Map([['A.azw3', [`T${i}`]]]))
    }

    expect(backups()).toHaveLength(CALIBRE_BACKUP_LIMIT)
  })

  test('does not write when the backup cannot be made', () => {
    // Arrange: a file where the backup folder should go.
    const before = writeMetadata([{ lpath: 'documents/A.azw3', tags: ['Old'] }])
    writeFileSync(path.join(mountpoint, '.kindle-organizer'), 'not a folder')

    // Act
    const ok = writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['New']]]))

    // Assert
    expect(ok).toBe(false)
    expect(readFileSync(metadataPath(), 'utf-8')).toBe(before)
  })
})

describe('restoreCalibreBackup', () => {
  test('restores the most recent backup and backs up what it replaces', () => {
    // Arrange: v1 on the device, then a write turns it into v2.
    writeMetadata([{ lpath: 'documents/A.azw3', tags: ['v1'] }])
    writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['v2']]]))

    // Act
    const restored = restoreCalibreBackup(mountpoint)

    // Assert
    expect(restored?.takenAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(readMetadata()[0].tags).toEqual(['v1'])
    const newest = backups().at(-1) ?? ''
    expect(JSON.parse(readFileSync(path.join(backupDir(), newest), 'utf-8'))[0].tags).toEqual(['v2'])
  })

  test('is null when there is no backup', () => {
    writeMetadata([{ lpath: 'documents/A.azw3', tags: ['v1'] }])

    expect(restoreCalibreBackup(mountpoint)).toBeNull()
    expect(readMetadata()[0].tags).toEqual(['v1'])
  })

  test('skips a damaged backup and uses the newest readable one', () => {
    mkdirSync(backupDir(), { recursive: true })
    writeFileSync(path.join(backupDir(), 'metadata.calibre.2026-01-01T00-00-00-000Z.json'), '[{"lpath":"documents/Ok.azw3"}]')
    writeFileSync(path.join(backupDir(), 'metadata.calibre.2026-02-01T00-00-00-000Z.json'), 'not json')

    const restored = restoreCalibreBackup(mountpoint)

    expect(restored?.takenAt).toBe('2026-01-01T00:00:00.000Z')
    expect(readMetadata()).toEqual([{ lpath: 'documents/Ok.azw3' }])
  })
})

describe('removeCalibreEntries', () => {
  test('drops the records of deleted books, ignoring case, and keeps the rest', () => {
    writeMetadata([
      { lpath: 'documents/A/Book.AZW3', tags: ['X'] },
      { lpath: 'documents/Other.azw3', tags: ['Y'] }
    ])

    const ok = removeCalibreEntries(mountpoint, ['A/Book.azw3'])

    expect(ok).toBe(true)
    expect(readMetadata().map((e) => e.lpath)).toEqual(['documents/Other.azw3'])
  })

  test('has nothing to do on a device without metadata.calibre', () => {
    expect(removeCalibreEntries(mountpoint, ['A.azw3'])).toBe(true)
    expect(existsSync(metadataPath())).toBe(false)
  })
})
