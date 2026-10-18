import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { fakeJpeg, writeEpub } from './setup/epubFixture'
import { writeMobi } from './setup/mobiFixture'
import { addDroppedFiles, removeLibraryBook, sendToKindle } from '../src/main/libraryService'
import { getConversion, getLibraryBook, listLibraryBooks } from '../src/main/library'

let userData: string
let src: string
let mountpoint: string

beforeEach(() => {
  userData = freshUserData()
  src = mkdtempSync(path.join(tmpdir(), 'kindle-drop-'))
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
  mkdirSync(path.join(mountpoint, 'documents'))
})

afterEach(() => {
  rmSync(src, { recursive: true, force: true })
  rmSync(mountpoint, { recursive: true, force: true })
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('addDroppedFiles', () => {
  test('adds a supported EPUB: metadata parsed, original copied, cover seeded', async () => {
    // Arrange
    const file = writeEpub(path.join(src, 'novel.epub'), {
      title: 'Dune',
      author: 'Frank Herbert',
      cover: fakeJpeg(),
      coverStyle: 'epub3'
    })

    // Act
    const [result] = await addDroppedFiles([file])

    // Assert
    expect(result.status).toBe('added')
    expect(result.book?.title).toBe('Dune')
    expect(result.book?.author).toBe('Frank Herbert')
    expect(result.book?.sourceFormat).toBe('epub')
    expect(result.book?.coverKey).toBeTruthy()

    // The original file is copied into the library store.
    const id = result.book!.id
    expect(existsSync(path.join(userData, 'library', id, 'original.epub'))).toBe(true)
    // The embedded cover was seeded into the cover cache.
    expect(existsSync(path.join(userData, 'covers', `${result.book!.coverKey}.jpg`))).toBe(true)
  })

  test('adds an already-Kindle format as-is (title from filename, no EPUB parse)', async () => {
    const file = path.join(src, 'My_Manual.azw3')
    writeFileSync(file, Buffer.from('AZW3 bytes'))

    const [result] = await addDroppedFiles([file])

    expect(result.status).toBe('added')
    expect(result.book?.sourceFormat).toBe('azw3')
    expect(result.book?.title).toBe('My Manual')
  })

  test('rejects an unsupported extension without creating a book', async () => {
    const file = path.join(src, 'notes.txt')
    writeFileSync(file, Buffer.from('hello'))

    const [result] = await addDroppedFiles([file])

    expect(result.status).toBe('unsupported')
    expect(result.book).toBeUndefined()
    expect(listLibraryBooks()).toHaveLength(0)
  })

  test('dedupes identical content: the second add is a duplicate of the first', async () => {
    const a = writeEpub(path.join(src, 'a.epub'), { title: 'Same', author: 'X' })
    const b = writeEpub(path.join(src, 'b.epub'), { title: 'Same', author: 'X' })

    const results = await addDroppedFiles([a, b])

    expect(results[0].status).toBe('added')
    expect(results[1].status).toBe('duplicate')
    // Same underlying book (identical bytes → identical content hash).
    expect(results[1].book?.id).toBe(results[0].book?.id)
    expect(listLibraryBooks()).toHaveLength(1)
  })

  test('processes a mixed batch and reports a status per file', async () => {
    const epub = writeEpub(path.join(src, 'good.epub'), { title: 'Good' })
    const bad = path.join(src, 'bad.txt')
    writeFileSync(bad, Buffer.from('x'))

    const results = await addDroppedFiles([epub, bad])

    expect(results.map((r) => r.status)).toEqual(['added', 'unsupported'])
  })
})

describe('sendToKindle', () => {
  const BOOK_UUID = '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'

  interface ConvertArgs {
    outputPath: string
    onProgress?: (p: number) => void
    metadata?: { title?: string; author?: string; coverPath?: string; identifier?: string }
  }

  /** A converter that produces a real (fixture) AZW3 at the requested path. */
  function fakeConverter(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_in: string, _fmt: string, opts: ConvertArgs) => {
      opts.onProgress?.(50)
      writeMobi(opts.outputPath, { uuid: BOOK_UUID, cdetype: 'EBOK' })
      return opts.outputPath
    })
  }

  /** An uploader that actually copies into the device's documents/ folder. */
  function fakeUploader(): ReturnType<typeof vi.fn> {
    return vi.fn(
      async (source: string, mount: string, target: string, onProgress?: (p: number) => void) => {
        copyFileSync(source, path.join(mount, 'documents', target))
        onProgress?.(100)
        return target
      }
    )
  }

  function readDeviceMetadata(): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(path.join(mountpoint, 'metadata.calibre'), 'utf-8'))
  }

  test('converts an EPUB then uploads it, emitting progress and stamping uploaded', async () => {
    // Arrange
    const file = writeEpub(path.join(src, 'novel.epub'), { title: 'Dune', author: 'Frank Herbert' })
    const [{ book }] = await addDroppedFiles([file])
    const emit = vi.fn()
    const convertMock = fakeConverter()
    const uploadMock = fakeUploader()

    // Act
    const result = await sendToKindle(book!.id, mountpoint, 'azw3', emit, {
      convert: convertMock,
      uploadFile: uploadMock
    })

    // Assert
    expect(convertMock).toHaveBeenCalledOnce()
    expect(uploadMock).toHaveBeenCalledOnce()
    expect(result.targetRelpath).toBe('Dune.azw3')
    expect(emit).toHaveBeenCalledWith('convert:progress', { libraryId: book!.id, percent: 50 })
    expect(emit).toHaveBeenCalledWith('upload:progress', { libraryId: book!.id, percent: 100 })
    expect(getConversion(book!.id, 'azw3')?.status).toBe('done')

    const after = getLibraryBook(book!.id)
    expect(after?.targetRelpath).toBe('Dune.azw3')
    expect(typeof after?.uploadedAt).toBe('number')
  })

  test('stamps the app title, author, book id and cached cover into the converted file', async () => {
    const cover = fakeJpeg()
    const file = writeEpub(path.join(src, 'novel.epub'), {
      title: 'Dune',
      author: 'Frank Herbert',
      cover,
      coverStyle: 'epub3'
    })
    const [{ book }] = await addDroppedFiles([file])
    const convertMock = fakeConverter()

    await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: convertMock,
      uploadFile: fakeUploader()
    })

    const [, , options] = convertMock.mock.calls[0] as [string, string, ConvertArgs]
    expect(options.metadata).toEqual({
      title: 'Dune',
      author: 'Frank Herbert',
      coverPath: path.join(userData, 'covers', `${book!.coverKey}.jpg`),
      identifier: book!.id
    })
  })

  test('writes the device cover thumbnail so the Kindle stops showing a placeholder', async () => {
    const cover = fakeJpeg()
    const file = writeEpub(path.join(src, 'novel.epub'), {
      title: 'Dune',
      author: 'Frank Herbert',
      cover,
      coverStyle: 'epub3'
    })
    const [{ book }] = await addDroppedFiles([file])

    await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: fakeConverter(),
      uploadFile: fakeUploader()
    })

    const thumbnail = path.join(
      mountpoint,
      'system',
      'thumbnails',
      `thumbnail_${BOOK_UUID}_EBOK_portrait.jpg`
    )
    expect(readFileSync(thumbnail)).toEqual(cover)
  })

  test('registers the uploaded book in metadata.calibre', async () => {
    const file = writeEpub(path.join(src, 'novel.epub'), { title: 'Dune', author: 'Frank Herbert' })
    const [{ book }] = await addDroppedFiles([file])

    await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: fakeConverter(),
      uploadFile: fakeUploader()
    })

    expect(readDeviceMetadata()[0]).toMatchObject({
      lpath: 'documents/Dune.azw3',
      title: 'Dune',
      authors: ['Frank Herbert'],
      author_sort: 'Herbert, Frank',
      tags: [],
      uuid: book!.id,
      mime: 'application/x-mobi8-ebook'
    })
  })

  test('skips the thumbnail when no cover was ever cached, still registering the book', async () => {
    const file = writeEpub(path.join(src, 'novel.epub'), { title: 'Dune', author: 'Frank Herbert' })
    const [{ book }] = await addDroppedFiles([file])
    expect(book!.coverKey).toBeUndefined()

    await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: fakeConverter(),
      uploadFile: fakeUploader()
    })

    expect(existsSync(path.join(mountpoint, 'system', 'thumbnails'))).toBe(false)
    expect(readDeviceMetadata()).toHaveLength(1)
  })

  test('completes the send even when the device metadata cannot be written', async () => {
    const file = writeEpub(path.join(src, 'novel.epub'), {
      title: 'Dune',
      author: 'Frank Herbert',
      cover: fakeJpeg(),
      coverStyle: 'epub3'
    })
    const [{ book }] = await addDroppedFiles([file])
    // A file where `system/` should be: both sidecar writes are now impossible.
    writeFileSync(path.join(mountpoint, 'system'), Buffer.from('not a directory'))
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), '{ not json', 'utf-8')

    const result = await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: fakeConverter(),
      uploadFile: fakeUploader()
    })

    expect(result.targetRelpath).toBe('Dune.azw3')
    expect(getLibraryBook(book!.id)?.uploadedAt).toEqual(expect.any(Number))
  })

  test('uploads an already-Kindle format as-is (no conversion)', async () => {
    const file = writeMobi(path.join(src, 'Manual.azw3'), { uuid: BOOK_UUID })
    const [{ book }] = await addDroppedFiles([file])
    const convertMock = vi.fn()
    const uploadMock = fakeUploader()

    const result = await sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
      convert: convertMock,
      uploadFile: uploadMock
    })

    expect(convertMock).not.toHaveBeenCalled()
    expect(uploadMock).toHaveBeenCalledWith(
      book!.originalPath,
      mountpoint,
      'Manual.azw3',
      expect.any(Function)
    )
    expect(result.targetRelpath).toBe('Manual.azw3')
    expect(readDeviceMetadata()[0]).toMatchObject({ lpath: 'documents/Manual.azw3' })
  })

  test('records a conversion error and does not upload when conversion fails', async () => {
    const file = writeEpub(path.join(src, 'bad.epub'), { title: 'Bad' })
    const [{ book }] = await addDroppedFiles([file])
    const convertMock = vi.fn(async () => {
      throw new Error('convert boom')
    })
    const uploadMock = vi.fn()

    await expect(
      sendToKindle(book!.id, mountpoint, 'azw3', vi.fn(), {
        convert: convertMock,
        uploadFile: uploadMock
      })
    ).rejects.toThrow('convert boom')

    expect(uploadMock).not.toHaveBeenCalled()
    expect(getConversion(book!.id, 'azw3')?.status).toBe('error')
    expect(getLibraryBook(book!.id)?.uploadedAt).toBeUndefined()
  })
})

describe('removeLibraryBook', () => {
  test('deletes the row and removes the on-disk library item directory', async () => {
    const file = writeEpub(path.join(src, 'toremove.epub'), { title: 'Bye' })
    const [{ book }] = await addDroppedFiles([file])
    const id = book!.id
    const dir = path.join(userData, 'library', id)
    expect(existsSync(dir)).toBe(true)

    await removeLibraryBook(id)

    expect(getLibraryBook(id)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })
})
