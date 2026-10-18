import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { writeEpub } from './setup/epubFixture'
import { writeMobi } from './setup/mobiFixture'
import {
  addLibraryFolder,
  describeLibraryFolders,
  removeLibraryFolder,
  syncLibraryFolder
} from '../src/main/libraryFolders'
import { addDroppedFiles, removeLibraryBook, sendToKindle } from '../src/main/libraryService'
import { getLibraryBook, listFolderBooks, listLibraryBooks, listLibraryFolders } from '../src/main/library'

let userData: string
/** Holds the library folders, files outside them and drop sources. Real path (macOS: /private/var). */
let scratch: string
/** The usual library folder. */
let root: string
let mountpoint: string

beforeEach(() => {
  userData = freshUserData()
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'library-folders-')))
  root = path.join(scratch, 'Books')
  mkdirSync(root)
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
  mkdirSync(path.join(mountpoint, 'documents'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(mountpoint, { recursive: true, force: true })
})

afterAll(() => {
  cleanupUserDataDirs()
})

/** An AZW3 stand-in: the folder sync only reads its bytes and its name. */
function writeAzw3(filePath: string, content = 'AZW3 bytes'): string {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
  return filePath
}

function writeEpubAt(filePath: string, title: string, author?: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true })
  return writeEpub(filePath, { title, author })
}

/** Adds `dir` as a library folder and runs its first sync. */
async function linkFolder(dir: string): Promise<string> {
  const folder = await addLibraryFolder(dir)
  await syncLibraryFolder(folder.id)
  return folder.id
}

describe('addLibraryFolder', () => {
  test('stores the real path of the chosen folder', async () => {
    // Arrange
    const shortcut = path.join(scratch, 'shortcut')
    symlinkSync(root, shortcut)

    // Act
    const folder = await addLibraryFolder(shortcut)

    // Assert
    expect(folder.path).toBe(root)
    expect(listLibraryFolders().map((f) => f.path)).toEqual([root])
  })

  test('refuses anything that is not an existing folder given by absolute path', async () => {
    const file = writeAzw3(path.join(scratch, 'file.azw3'))

    await expect(addLibraryFolder(file)).rejects.toThrow('LIBRARY_FOLDER_INVALID')
    await expect(addLibraryFolder(path.join(scratch, 'missing'))).rejects.toThrow('LIBRARY_FOLDER_INVALID')
    await expect(addLibraryFolder('relative/books')).rejects.toThrow('LIBRARY_FOLDER_INVALID')
    expect(listLibraryFolders()).toEqual([])
  })

  test('refuses a folder that is, contains or sits inside one already in the library', async () => {
    // Arrange
    const inner = path.join(root, 'Sci-fi')
    mkdirSync(path.join(inner, 'Old'), { recursive: true })
    await addLibraryFolder(inner)

    // Act + Assert
    await expect(addLibraryFolder(inner)).rejects.toThrow('LIBRARY_FOLDER_OVERLAP')
    await expect(addLibraryFolder(root)).rejects.toThrow('LIBRARY_FOLDER_OVERLAP')
    await expect(addLibraryFolder(path.join(inner, 'Old'))).rejects.toThrow('LIBRARY_FOLDER_OVERLAP')
    expect(listLibraryFolders()).toHaveLength(1)
  })

  test('accepts a sibling whose name merely starts the same way', async () => {
    const sibling = path.join(scratch, 'Books2')
    mkdirSync(sibling)
    await addLibraryFolder(root)

    await expect(addLibraryFolder(sibling)).resolves.toMatchObject({ path: sibling })
  })
})

describe('syncLibraryFolder', () => {
  test('adds the books it finds, subfolders included, reading them in place', async () => {
    // Arrange
    const epub = writeEpubAt(path.join(root, 'Herbert', 'dune.epub'), 'Dune', 'Frank Herbert')
    const azw3 = writeAzw3(path.join(root, 'My_Manual.azw3'))
    const folder = await addLibraryFolder(root)

    // Act
    const result = await syncLibraryFolder(folder.id)

    // Assert
    expect(result).toEqual({ folderId: folder.id, status: 'ok', added: 2, updated: 0, removed: 0, errors: 0 })
    const books = listFolderBooks(folder.id)
    const dune = books.find((b) => b.title === 'Dune')
    expect(dune?.author).toBe('Frank Herbert')
    expect(dune?.originalPath).toBe(epub)
    expect(dune?.filename).toBe('dune.epub')
    const manual = books.find((b) => b.sourceFormat === 'azw3')
    expect(manual?.title).toBe('My Manual')
    expect(manual?.originalPath).toBe(azw3)
    // Nothing was copied into the app's own store.
    expect(existsSync(path.join(userData, 'library'))).toBe(false)
  })

  test('skips hidden entries, other file types and symbolic links', async () => {
    // Arrange
    writeAzw3(path.join(root, '.hidden.azw3'))
    writeAzw3(path.join(root, '.git', 'inside.azw3'), 'inside')
    writeFileSync(path.join(root, 'notes.txt'), 'notes')
    const outside = writeAzw3(path.join(scratch, 'Outside', 'secret.azw3'), 'outside')
    symlinkSync(outside, path.join(root, 'link.azw3'))
    symlinkSync(path.join(scratch, 'Outside'), path.join(root, 'linked-dir'))
    writeAzw3(path.join(root, 'real.azw3'), 'real')
    const folder = await addLibraryFolder(root)

    // Act
    const result = await syncLibraryFolder(folder.id)

    // Assert
    expect(result.added).toBe(1)
    expect(listFolderBooks(folder.id).map((b) => b.filename)).toEqual(['real.azw3'])
  })

  test('a second sync with nothing changed changes nothing', async () => {
    writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    const [before] = listFolderBooks(folderId)

    const result = await syncLibraryFolder(folderId)

    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, errors: 0 })
    expect(listFolderBooks(folderId)).toEqual([before])
  })

  test('a renamed file keeps its library id', async () => {
    // Arrange
    const original = writeAzw3(path.join(root, 'old name.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const renamed = path.join(root, 'Moved', 'new name.azw3')
    mkdirSync(path.dirname(renamed))
    renameSync(original, renamed)

    // Act
    const result = await syncLibraryFolder(folderId)

    // Assert
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 })
    const after = getLibraryBook(book.id)
    expect(after?.originalPath).toBe(renamed)
    expect(after?.filename).toBe('new name.azw3')
  })

  test('a deleted file leaves the library, together with its conversion cache', async () => {
    // Arrange
    const file = writeAzw3(path.join(root, 'gone.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const cache = path.join(userData, 'library', book.id)
    mkdirSync(cache, { recursive: true })
    writeFileSync(path.join(cache, 'converted.azw3'), 'converted')
    rmSync(file)

    // Act
    const result = await syncLibraryFolder(folderId)

    // Assert
    expect(result).toMatchObject({ added: 0, removed: 1 })
    expect(getLibraryBook(book.id)).toBeNull()
    expect(existsSync(cache)).toBe(false)
  })

  test('new content at the same path updates the book in place', async () => {
    // Arrange
    const file = writeEpubAt(path.join(root, 'dune.epub'), 'Dune')
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    writeEpubAt(file, 'Dune Messiah', 'Frank Herbert')
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)

    // Act
    const result = await syncLibraryFolder(folderId)

    // Assert
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 })
    const after = getLibraryBook(book.id)
    expect(after?.title).toBe('Dune Messiah')
    expect(after?.author).toBe('Frank Herbert')
    expect(after?.contentHash).not.toBe(book.contentHash)
  })

  test('a folder that cannot be reached removes nothing', async () => {
    // Arrange: an external disk that was unplugged looks exactly like this.
    writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    renameSync(root, path.join(scratch, 'Unplugged'))

    // Act
    const result = await syncLibraryFolder(folderId)

    // Assert
    expect(result).toEqual({ folderId, status: 'unavailable', added: 0, updated: 0, removed: 0, errors: 0 })
    expect(listFolderBooks(folderId)).toHaveLength(1)
  })

  test.skipIf(process.getuid?.() === 0)('a subfolder it cannot read removes nothing', async () => {
    // Arrange
    const locked = path.join(root, 'Locked')
    writeAzw3(path.join(locked, 'a.azw3'))
    const folderId = await linkFolder(root)
    chmodSync(locked, 0o000)

    try {
      // Act
      const result = await syncLibraryFolder(folderId)

      // Assert
      expect(result.removed).toBe(0)
      expect(listFolderBooks(folderId)).toHaveLength(1)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test('a book already added by drag and drop is not added again', async () => {
    // Arrange
    const dropped = writeAzw3(path.join(scratch, 'drop', 'same.azw3'), 'same bytes')
    await addDroppedFiles([dropped])
    copyFileSync(dropped, path.join(root, 'same.azw3'))
    const folder = await addLibraryFolder(root)

    // Act
    const result = await syncLibraryFolder(folder.id)

    // Assert
    expect(result).toMatchObject({ added: 0, errors: 0 })
    expect(listLibraryBooks()).toHaveLength(1)
  })

  test('two copies of one book in the folder make one library book', async () => {
    writeAzw3(path.join(root, 'a.azw3'), 'same bytes')
    writeAzw3(path.join(root, 'copy of a.azw3'), 'same bytes')
    const folder = await addLibraryFolder(root)

    const result = await syncLibraryFolder(folder.id)

    expect(result).toMatchObject({ added: 1, errors: 0 })
    expect(listFolderBooks(folder.id)).toHaveLength(1)
  })

  test('a book moved from one library folder to another keeps its id', async () => {
    // Arrange
    const folderA = path.join(scratch, 'A')
    const folderB = path.join(scratch, 'B')
    mkdirSync(folderB)
    const file = writeAzw3(path.join(folderA, 'a.azw3'))
    const a = await linkFolder(folderA)
    const b = await linkFolder(folderB)
    const [book] = listFolderBooks(a)
    renameSync(file, path.join(folderB, 'a.azw3'))

    // Act: the destination is noticed first, as a watcher may well do.
    const resultB = await syncLibraryFolder(b)
    const resultA = await syncLibraryFolder(a)

    // Assert
    expect(resultB).toMatchObject({ added: 0, updated: 1 })
    expect(resultA).toMatchObject({ removed: 0 })
    expect(getLibraryBook(book.id)?.folderId).toBe(b)
    expect(listLibraryBooks()).toHaveLength(1)
  })

  test('overlapping syncs of one folder add each book once', async () => {
    writeAzw3(path.join(root, 'a.azw3'), 'a')
    writeEpubAt(path.join(root, 'b.epub'), 'B')
    const folder = await addLibraryFolder(root)

    const results = await Promise.all([syncLibraryFolder(folder.id), syncLibraryFolder(folder.id)])

    expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(2)
    expect(results.reduce((sum, r) => sum + r.errors, 0)).toBe(0)
    expect(listFolderBooks(folder.id)).toHaveLength(2)
  })

  test('an unknown folder id is reported unavailable', async () => {
    await expect(syncLibraryFolder('nope')).resolves.toMatchObject({ status: 'unavailable', added: 0 })
  })
})

describe('removeLibraryFolder', () => {
  test('drops the folder and its books from the library without touching the files', async () => {
    // Arrange
    const file = writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const cache = path.join(userData, 'library', book.id)
    mkdirSync(cache, { recursive: true })
    const dropped = writeAzw3(path.join(scratch, 'drop', 'dropped.azw3'), 'dropped')
    await addDroppedFiles([dropped])

    // Act
    await removeLibraryFolder(folderId)

    // Assert
    expect(listLibraryFolders()).toEqual([])
    expect(listLibraryBooks().map((b) => b.filename)).toEqual(['dropped.azw3'])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(cache)).toBe(false)
  })
})

describe('describeLibraryFolders', () => {
  test('reports each folder with its book count and whether it can be reached', async () => {
    // Arrange
    writeAzw3(path.join(root, 'a.azw3'), 'a')
    writeAzw3(path.join(root, 'b.azw3'), 'b')
    const other = path.join(scratch, 'Other')
    writeAzw3(path.join(other, 'c.azw3'), 'c')
    await linkFolder(root)
    await linkFolder(other)
    renameSync(other, path.join(scratch, 'Unplugged'))

    // Act
    const folders = await describeLibraryFolders()

    // Assert
    expect(folders.map((f) => [f.path, f.bookCount, f.available])).toEqual([
      [root, 2, true],
      [other, 1, false]
    ])
  })
})

describe('folder books and the rest of the library', () => {
  interface ConvertArgs {
    outputPath: string
  }

  function fakeConverter(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_input: string, opts: ConvertArgs) => {
      writeMobi(opts.outputPath, { uuid: '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33', cdetype: 'EBOK' })
      return opts.outputPath
    })
  }

  function fakeUploader(): ReturnType<typeof vi.fn> {
    return vi.fn(async (source: string, mount: string, target: string) => {
      copyFileSync(source, path.join(mount, 'documents', target))
      return target
    })
  }

  test('removing a folder book from the library is refused and the file stays', async () => {
    const file = writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)

    await expect(removeLibraryBook(book.id)).rejects.toThrow('LIBRARY_FOLDER_BOOK')
    expect(getLibraryBook(book.id)).not.toBeNull()
    expect(existsSync(file)).toBe(true)
  })

  test('sending a Kindle-format folder book uploads the file from the folder', async () => {
    // Arrange
    const file = writeAzw3(path.join(root, 'Manual.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const upload = fakeUploader()

    // Act
    await sendToKindle(book.id, mountpoint, 'azw3', vi.fn(), { uploadFile: upload })

    // Assert
    expect(upload.mock.calls[0][0]).toBe(file)
    expect(typeof getLibraryBook(book.id)?.uploadedAt).toBe('number')
  })

  test('sending a folder EPUB converts it from the folder into the app cache', async () => {
    // Arrange
    const file = writeEpubAt(path.join(root, 'dune.epub'), 'Dune')
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const convert = fakeConverter()

    // Act
    await sendToKindle(book.id, mountpoint, 'azw3', vi.fn(), { convert, uploadFile: fakeUploader() })

    // Assert
    expect(convert.mock.calls[0][0]).toBe(file)
    expect(convert.mock.calls[0][1].outputPath).toBe(path.join(userData, 'library', book.id, 'converted.azw3'))
    expect(readdirSync(root)).toEqual(['dune.epub'])
  })

  test('sending a folder book whose file is gone fails with a clear code', async () => {
    const file = writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    rmSync(file)
    const upload = fakeUploader()

    await expect(sendToKindle(book.id, mountpoint, 'azw3', vi.fn(), { uploadFile: upload })).rejects.toThrow(
      'LIBRARY_FILE_MISSING'
    )
    expect(upload).not.toHaveBeenCalled()
  })

  test('a folder file swapped for a link to outside the folder is never read', async () => {
    // Arrange
    const file = writeAzw3(path.join(root, 'a.azw3'))
    const folderId = await linkFolder(root)
    const [book] = listFolderBooks(folderId)
    const outside = writeAzw3(path.join(scratch, 'Private', 'diary.azw3'), 'private')
    rmSync(file)
    symlinkSync(outside, file)
    const upload = fakeUploader()

    // Act + Assert
    await expect(sendToKindle(book.id, mountpoint, 'azw3', vi.fn(), { uploadFile: upload })).rejects.toThrow(
      'LIBRARY_FILE_MISSING'
    )
    expect(upload).not.toHaveBeenCalled()
  })
})
