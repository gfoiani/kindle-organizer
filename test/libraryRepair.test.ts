import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { writeEpub } from './setup/epubFixture'
import { getLibraryBook, insertLibraryBook, insertLibraryFolder } from '../src/main/library'
import { repairLibraryMetadata } from '../src/main/libraryRepair'

let src: string

beforeEach(() => {
  freshUserData()
  src = mkdtempSync(path.join(tmpdir(), 'kindle-repair-'))
})

afterEach(() => {
  rmSync(src, { recursive: true, force: true })
})

afterAll(() => {
  cleanupUserDataDirs()
})

/** A row as an older reader left it: the EPUB names its author, the row does not. */
function addAuthorlessRow(id: string, file: string, extra: { folderId?: string; sourceFormat?: string } = {}): void {
  insertLibraryBook({
    id,
    contentHash: `hash-${id}`,
    originalPath: file,
    filename: path.basename(file),
    title: 'Dungeon Crawler Carl',
    sourceFormat: extra.sourceFormat ?? 'epub',
    ...(extra.folderId ? { folderId: extra.folderId } : {})
  })
}

describe('repairLibraryMetadata', () => {
  test('fills in the author an older reader missed', async () => {
    // Arrange
    const file = writeEpub(path.join(src, 'dcc.epub'), {
      title: 'Dungeon Crawler Carl',
      author: 'Matt Dinniman',
      unprefixedDublinCore: true
    })
    addAuthorlessRow('a', file)

    // Act
    const repaired = await repairLibraryMetadata()

    // Assert
    expect(repaired).toBe(1)
    expect(getLibraryBook('a')?.author).toBe('Matt Dinniman')
  })

  test('runs once: rows added after a complete repair are not re-read', async () => {
    // Arrange
    await repairLibraryMetadata()
    addAuthorlessRow('late', writeEpub(path.join(src, 'late.epub'), { author: 'Someone' }))

    // Act
    const repaired = await repairLibraryMetadata()

    // Assert
    expect(repaired).toBe(0)
    expect(getLibraryBook('late')?.author).toBeUndefined()
  })

  test('tries again on the next start when a file could not be read', async () => {
    // Arrange: the book's file is away (an unplugged disk) during the first repair.
    const file = writeEpub(path.join(src, 'away.epub'), { author: 'Matt Dinniman' })
    const awayPath = `${file}.away`
    renameSync(file, awayPath)
    addAuthorlessRow('away', file)
    await repairLibraryMetadata()
    renameSync(awayPath, file)

    // Act
    const repaired = await repairLibraryMetadata()

    // Assert
    expect(repaired).toBe(1)
    expect(getLibraryBook('away')?.author).toBe('Matt Dinniman')
  })

  test('reads a folder book only while it is still a file inside its folder', async () => {
    // Arrange: the row points outside the folder it claims to belong to.
    const folder = mkdtempSync(path.join(tmpdir(), 'kindle-repair-folder-'))
    insertLibraryFolder('f1', folder)
    addAuthorlessRow('outside', writeEpub(path.join(src, 'outside.epub'), { author: 'Matt Dinniman' }), {
      folderId: 'f1'
    })

    // Act
    const repaired = await repairLibraryMetadata()

    // Assert
    expect(repaired).toBe(0)
    expect(getLibraryBook('outside')?.author).toBeUndefined()
    rmSync(folder, { recursive: true, force: true })
  })

  test('leaves books that are not EPUBs, or truly have no author, as they are', async () => {
    // Arrange
    addAuthorlessRow('anon', writeEpub(path.join(src, 'anon.epub'), { title: 'Anonymous' }))
    addAuthorlessRow('mobi', path.join(src, 'book.azw3'), { sourceFormat: 'azw3' })

    // Act
    const repaired = await repairLibraryMetadata()

    // Assert
    expect(repaired).toBe(0)
    expect(getLibraryBook('anon')?.author).toBeUndefined()
    expect(getLibraryBook('mobi')?.author).toBeUndefined()
  })
})
