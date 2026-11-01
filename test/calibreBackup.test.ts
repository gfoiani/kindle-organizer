import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  CALIBRE_BACKUP_LIMIT,
  describeCalibreBackups,
  removeCalibreEntries,
  restoreCalibreBackup,
  upsertCalibreEntry,
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

  test('a burst of uploads keeps one copy: the file as it was before the first', () => {
    // Arrange
    const before = writeMetadata([{ lpath: 'documents/Old.azw3', tags: ['Keep'] }])

    // Act: a bulk send registers one book after the other.
    for (let i = 0; i < CALIBRE_BACKUP_LIMIT + 5; i++) {
      upsertCalibreEntry(mountpoint, { relpath: `Book${i}.azw3`, title: `Book ${i}`, size: 1, uuid: `uuid-${i}` })
    }

    // Assert
    expect(backups()).toHaveLength(1)
    expect(readFileSync(path.join(backupDir(), backups()[0]), 'utf-8')).toBe(before)
  })

  test('deleting books one at a time keeps the copy from before the first delete', () => {
    // Arrange: the collections the user wrote, then more single deletes than the window holds.
    const before = writeMetadata(
      Array.from({ length: CALIBRE_BACKUP_LIMIT + 5 }, (_, i) => ({ lpath: `documents/Book${i}.azw3`, tags: ['Keep'] }))
    )

    // Act
    for (let i = 0; i < CALIBRE_BACKUP_LIMIT + 5; i++) {
      removeCalibreEntries(mountpoint, [`Book${i}.azw3`])
    }

    // Assert
    expect(backups()).toHaveLength(1)
    expect(readFileSync(path.join(backupDir(), backups()[0]), 'utf-8')).toBe(before)
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

const tagsIn = (id: string): unknown => JSON.parse(readFileSync(path.join(backupDir(), id), 'utf-8'))[0].tags

describe('describeCalibreBackups', () => {
  test('lists the device backups newest first, by file name and time only', () => {
    mkdirSync(backupDir(), { recursive: true })
    writeFileSync(path.join(backupDir(), 'metadata.calibre.2026-01-01T00-00-00-000Z.json'), '[]')
    writeFileSync(path.join(backupDir(), 'metadata.calibre.2026-02-01T00-00-00-000Z.json'), '[]')
    writeFileSync(path.join(backupDir(), 'unrelated.txt'), '')

    expect(describeCalibreBackups(mountpoint)).toEqual([
      { id: 'metadata.calibre.2026-02-01T00-00-00-000Z.json', takenAt: '2026-02-01T00:00:00.000Z' },
      { id: 'metadata.calibre.2026-01-01T00-00-00-000Z.json', takenAt: '2026-01-01T00:00:00.000Z' }
    ])
  })
})

describe('restoreCalibreBackup', () => {
  test('restores the chosen copy, older than the latest, and keeps one of what it replaces', () => {
    // Arrange: v1 → v2 → v3, so the backups hold v2 (newest) and v1.
    writeMetadata([{ lpath: 'documents/A.azw3', tags: ['v1'] }])
    writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['v2']]]))
    writeCalibreMetadata(mountpoint, new Map([['A.azw3', ['v3']]]))
    const [, oldest] = describeCalibreBackups(mountpoint)

    // Act
    const restored = restoreCalibreBackup(mountpoint, oldest.id)

    // Assert
    expect(restored).toEqual({ takenAt: oldest.takenAt })
    expect(readMetadata()[0].tags).toEqual(['v1'])
    expect(tagsIn(describeCalibreBackups(mountpoint)[0].id)).toEqual(['v3'])
  })

  test('is null for anything that is not one of the device backups, never treating it as a path', () => {
    writeMetadata([{ lpath: 'documents/A.azw3', tags: ['v1'] }])

    expect(restoreCalibreBackup(mountpoint, '../metadata.calibre')).toBeNull()
    expect(restoreCalibreBackup(mountpoint, 'metadata.calibre.2026-01-01T00-00-00-000Z.json')).toBeNull()
    expect(readMetadata()[0].tags).toEqual(['v1'])
  })

  test('refuses a damaged backup and leaves the file untouched', () => {
    writeMetadata([{ lpath: 'documents/A.azw3', tags: ['v1'] }])
    mkdirSync(backupDir(), { recursive: true })
    const damaged = 'metadata.calibre.2026-02-01T00-00-00-000Z.json'
    writeFileSync(path.join(backupDir(), damaged), 'not json')

    expect(() => restoreCalibreBackup(mountpoint, damaged)).toThrow()
    expect(readMetadata()[0].tags).toEqual(['v1'])
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
