import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { fakeJpeg, writeEpub } from './setup/epubFixture'
import { addDroppedFiles, removeLibraryBook, sendToKindle } from '../src/main/libraryService'
import { getConversion, getLibraryBook, listLibraryBooks } from '../src/main/library'

let userData: string
let src: string

beforeEach(() => {
  userData = freshUserData()
  src = mkdtempSync(path.join(tmpdir(), 'kindle-drop-'))
})

afterEach(() => {
  rmSync(src, { recursive: true, force: true })
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
  test('converts an EPUB then uploads it, emitting progress and stamping uploaded', async () => {
    // Arrange
    const file = writeEpub(path.join(src, 'novel.epub'), { title: 'Dune', author: 'Frank Herbert' })
    const [{ book }] = await addDroppedFiles([file])
    const emit = vi.fn()
    const convertMock = vi.fn(async (_in: string, _fmt: string, opts: { outputPath: string; onProgress?: (p: number) => void }) => {
      opts.onProgress?.(50)
      return opts.outputPath
    })
    const uploadMock = vi.fn(
      async (_s: string, _m: string, target: string, onProgress?: (p: number) => void) => {
        onProgress?.(100)
        return target
      }
    )

    // Act
    const result = await sendToKindle(book!.id, '/mnt/kindle', 'azw3', emit, {
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

  test('uploads an already-Kindle format as-is (no conversion)', async () => {
    const file = path.join(src, 'Manual.azw3')
    writeFileSync(file, Buffer.from('azw3 bytes'))
    const [{ book }] = await addDroppedFiles([file])
    const convertMock = vi.fn()
    const uploadMock = vi.fn(async (_s: string, _m: string, target: string) => target)

    const result = await sendToKindle(book!.id, '/mnt/kindle', 'azw3', vi.fn(), {
      convert: convertMock,
      uploadFile: uploadMock
    })

    expect(convertMock).not.toHaveBeenCalled()
    expect(uploadMock).toHaveBeenCalledWith(
      book!.originalPath,
      '/mnt/kindle',
      'Manual.azw3',
      expect.any(Function)
    )
    expect(result.targetRelpath).toBe('Manual.azw3')
  })

  test('records a conversion error and does not upload when conversion fails', async () => {
    const file = writeEpub(path.join(src, 'bad.epub'), { title: 'Bad' })
    const [{ book }] = await addDroppedFiles([file])
    const convertMock = vi.fn(async () => {
      throw new Error('convert boom')
    })
    const uploadMock = vi.fn()

    await expect(
      sendToKindle(book!.id, '/mnt/kindle', 'azw3', vi.fn(), {
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
