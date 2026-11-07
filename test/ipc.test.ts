import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { dialog, shell } from 'electron'
import { cleanupUserDataDirs, freshUserData, invokeIpc } from './setup/electron-mock'
import { writeEpub, fakeJpeg } from './setup/epubFixture'
import { writeMobi } from './setup/mobiFixture'

vi.mock('systeminformation', () => ({ default: { blockDevices: vi.fn() } }))

import si from 'systeminformation'
import { registerIpcHandlers } from '../src/main/ipc'
import { getCachePath } from '../src/main/coverPaths'
import type { LibraryFolderWatching } from '../src/main/libraryWatcher'
import type { Collection, KindleBook } from '../src/main/kindle'
import type { LibraryBook } from '../src/main/library'

/**
 * The IPC registry is the renderer's only way into the main process, so these
 * tests drive it the way the renderer does: by channel, with untrusted
 * arguments, against a temp directory standing for the Kindle.
 */

type BlockDevice = Awaited<ReturnType<typeof si.blockDevices>>[number]
const blockDevices = vi.mocked(si.blockDevices)

const folderWatching = {
  refresh: vi.fn(),
  link: vi.fn(async (folderPath: string) => ({ folder: { id: 'f1', path: folderPath }, result: null })),
  forget: vi.fn(async () => undefined),
  syncAll: vi.fn(async () => []),
  stop: vi.fn()
}

let mountpoint: string
let scratch: string

/** A fresh temp volume with documents/, reported by detection as a Kindle. */
function connectKindle(): string {
  const mount = mkdtempSync(path.join(tmpdir(), 'ipc-kindle-'))
  mkdirSync(path.join(mount, 'documents'))
  blockDevices.mockResolvedValue([{ name: 'disk4', mount, label: 'Kindle', model: '', size: 1 } as BlockDevice])
  return mount
}

function documents(...parts: string[]): string {
  return path.join(mountpoint, 'documents', ...parts)
}

function writeMetadata(entries: unknown[]): void {
  writeFileSync(path.join(mountpoint, 'metadata.calibre'), JSON.stringify(entries))
}

function readMetadata(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(mountpoint, 'metadata.calibre'), 'utf-8'))
}

async function createCollection(name: string): Promise<Collection> {
  return (await invokeIpc('kindle:create-collection', name)) as Collection
}

beforeAll(() => {
  registerIpcHandlers(folderWatching as unknown as LibraryFolderWatching)
})

beforeEach(() => {
  freshUserData()
  blockDevices.mockReset()
  mountpoint = connectKindle()
  scratch = mkdtempSync(path.join(tmpdir(), 'ipc-scratch-'))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('only a connected Kindle is read or written', () => {
  test('reading books refuses a path detection does not report as a Kindle', async () => {
    await expect(invokeIpc('kindle:read-documents', scratch)).rejects.toThrow('DEVICE_NOT_FOUND')
  })

  test('importing collections refuses a path detection does not report as a Kindle', async () => {
    writeFileSync(path.join(scratch, 'metadata.calibre'), JSON.stringify([{ lpath: 'documents/a.azw3', tags: ['X'] }]))

    await expect(invokeIpc('kindle:sync-calibre', scratch)).rejects.toThrow('DEVICE_NOT_FOUND')
  })

  test.each([
    ['kindle-sync:refresh', []],
    ['kindle-sync:answer-first-sync', ['discard']],
    ['kindle:upload-book', ['3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33']],
    ['kindle:delete-device-books', [[]]],
    ['kindle:list-collections-backups', []],
    ['kindle:restore-collections-backup', ['backup']],
    ['kindle:eject', []]
  ])('%s refuses a path that is not a Kindle', async (channel, rest) => {
    const args = channel === 'kindle:upload-book' ? [...rest, scratch] : [scratch, ...rest]

    await expect(invokeIpc(channel, ...args)).rejects.toThrow('DEVICE_NOT_FOUND')
  })

  test('a refresh detects the Kindle once: reading its books reuses that detection', async () => {
    await invokeIpc('kindle:detect-drives')
    await invokeIpc('kindle:read-documents', mountpoint)
    await invokeIpc('kindle:sync-calibre', mountpoint)

    expect(blockDevices).toHaveBeenCalledTimes(1)
  })
})

describe('kindle:read-documents', () => {
  test('lists the books with the title the user edited and the ISBN calibre recorded', async () => {
    // Arrange
    mkdirSync(documents('Herbert'))
    writeFileSync(documents('Herbert', 'dune.azw3'), '')
    writeMetadata([{ lpath: 'documents/Herbert/dune.azw3', isbn: '9780441013593' }])
    await invokeIpc('kindle:update-book-metadata', 'Herbert/dune.azw3', 'Dune', 'Frank Herbert')

    // Act
    const books = (await invokeIpc('kindle:read-documents', mountpoint)) as KindleBook[]

    // Assert
    expect(books).toEqual([
      expect.objectContaining({ relpath: 'Herbert/dune.azw3', title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593' })
    ])
  })
})

describe('collections', () => {
  test('are created, renamed, filled, emptied and deleted through their channels', async () => {
    const created = await createCollection('Sci-Fi')
    const renamed = (await invokeIpc('kindle:rename-collections', [{ id: created.id, newName: 'Fantascienza' }])) as Collection[]
    await invokeIpc('kindle:add-book-to-collection', created.id, 'Dune.azw3')
    const books = await invokeIpc('kindle:get-collection-books', created.id)
    const ofBook = await invokeIpc('kindle:get-book-collections', 'Dune.azw3')
    await invokeIpc('kindle:remove-book-from-collection', created.id, 'Dune.azw3')
    const afterRemove = await invokeIpc('kindle:get-collection-books', created.id)
    const afterDelete = await invokeIpc('kindle:delete-collections', [created.id])

    expect(renamed.map((c) => c.name)).toEqual(['Fantascienza'])
    expect(books).toEqual(['Dune.azw3'])
    expect(ofBook).toEqual([created.id])
    expect(afterRemove).toEqual([])
    expect(afterDelete).toEqual([])
  })

  test('a batch membership lands in one call and shows up in the book tags', async () => {
    await invokeIpc('kindle:ensure-collections-contain', [{ name: 'Gialli', relpaths: ['a.azw3', 'b.azw3'] }])

    const tags = await invokeIpc('kindle:get-book-tags', ['a.azw3', 'c.azw3'])
    const collections = (await invokeIpc('kindle:get-local-collections')) as Collection[]

    expect(tags).toEqual({ 'a.azw3': ['Gialli'], 'b.azw3': ['Gialli'], 'c.azw3': [] })
    expect(collections).toEqual([expect.objectContaining({ name: 'Gialli', bookCount: 2 })])
  })

  test('are imported from metadata.calibre', async () => {
    writeMetadata([{ lpath: 'documents/a.azw3', tags: ['Classici'] }])

    await invokeIpc('kindle:sync-calibre', mountpoint)

    expect(await invokeIpc('kindle:get-local-collections')).toEqual([
      expect.objectContaining({ name: 'Classici', source: 'calibre', bookCount: 1 })
    ])
  })

  test('an unreadable metadata.calibre keeps the collections imported before', async () => {
    writeMetadata([{ lpath: 'documents/a.azw3', tags: ['Classici'] }])
    await invokeIpc('kindle:sync-calibre', mountpoint)
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), '{ half written')

    await invokeIpc('kindle:sync-calibre', mountpoint)

    expect(await invokeIpc('kindle:get-local-collections')).toEqual([expect.objectContaining({ name: 'Classici' })])
  })

  test('lose the books deleted from the Kindle', async () => {
    const book = writeMobi(documents('Dune.azw3'), { uuid: 'u1', cdetype: 'EBOK' })
    const collection = await createCollection('Sci-Fi')
    await invokeIpc('kindle:add-book-to-collection', collection.id, 'Dune.azw3')

    const result = await invokeIpc('kindle:delete-device-books', mountpoint, [book])

    expect(result).toEqual({ deleted: [book], failed: [] })
    expect(await invokeIpc('kindle:get-collection-books', collection.id)).toEqual([])
  })

  test('list and restore the metadata.calibre backups of the connected Kindle', async () => {
    // Arrange: deleting a book rewrites metadata.calibre, which takes a backup first.
    const before = [
      { lpath: 'documents/a.azw3', tags: ['Old'] },
      { lpath: 'documents/b.azw3', tags: [] }
    ]
    writeMetadata(before)
    writeFileSync(documents('a.azw3'), '')
    writeFileSync(documents('b.azw3'), '')
    await invokeIpc('kindle:delete-device-books', mountpoint, [documents('b.azw3')])

    // Act
    const [backup] = (await invokeIpc('kindle:list-collections-backups', mountpoint)) as Array<{ id: string }>
    const restored = await invokeIpc('kindle:restore-collections-backup', mountpoint, backup.id)

    // Assert
    expect(restored).toMatchObject({ takenAt: expect.any(String) })
    expect(readMetadata()).toEqual(before)
  })
})

describe('untrusted arguments are refused before they reach a store', () => {
  test.each([
    ['kindle:create-collection', [42]],
    ['kindle:get-collection-books', [undefined]],
    ['kindle:update-book-metadata', ['a.azw3', 'Title', 7]],
    ['kindle:rename-collections', [[{ id: 'x' }]]],
    ['kindle:rename-collections', ['not an array']],
    ['kindle:ensure-collections-contain', [[{ name: 'X', relpaths: [1] }]]],
    ['kindle:ensure-collections-contain', [[null]]],
    ['kindle:delete-collections', ['x']],
    ['kindle:add-books', ['/a.epub']],
    ['menu:popup', [Number.NaN, 0]],
    ['menu:set-labels', ['About', null]]
  ])('%s with %j', async (channel, args) => {
    await expect(invokeIpc(channel, ...args)).rejects.toBeInstanceOf(TypeError)
  })
})

describe('library', () => {
  test('adds dropped books, lists them and removes them', async () => {
    const file = writeEpub(path.join(scratch, 'dune.epub'), { title: 'Dune', author: 'Frank Herbert' })

    const [added] = (await invokeIpc('kindle:add-books', [file])) as Array<{ status: string; book: LibraryBook }>
    const listed = (await invokeIpc('kindle:get-library')) as LibraryBook[]
    await invokeIpc('kindle:remove-library-book', added.book.id)

    expect(added.status).toBe('added')
    expect(listed.map((b) => b.title)).toEqual(['Dune'])
    expect(await invokeIpc('kindle:get-library')).toEqual([])
  })

  test('reveals the file the library recorded for a book, never a path from the renderer', async () => {
    const file = writeEpub(path.join(scratch, 'dune.epub'), { title: 'Dune' })
    const [{ book }] = (await invokeIpc('kindle:add-books', [file])) as Array<{ book: LibraryBook }>

    await invokeIpc('library:reveal-book', book.id)

    expect(shell.showItemInFolder).toHaveBeenCalledWith(book.originalPath)
    await expect(invokeIpc('library:reveal-book', 'missing')).rejects.toThrow('not found')
  })

  test('clearing the cover cache keeps the covers taken from library books', async () => {
    const file = writeEpub(path.join(scratch, 'dune.epub'), { title: 'Dune', cover: fakeJpeg(), coverStyle: 'epub3' })
    const [{ book }] = (await invokeIpc('kindle:add-books', [file])) as Array<{ book: LibraryBook }>

    await invokeIpc('kindle:clear-cover-cache')

    expect(book.coverKey).toBeDefined()
    expect(existsSync(getCachePath(book.coverKey!))).toBe(true)
  })

  test('a send goes to the connected Kindle', async () => {
    const file = writeMobi(path.join(scratch, 'Manual.azw3'), { uuid: 'u2', cdetype: 'EBOK' })
    const [{ book }] = (await invokeIpc('kindle:add-books', [file])) as Array<{ book: LibraryBook }>

    const result = await invokeIpc('kindle:upload-book', book.id, mountpoint)

    expect(result).toMatchObject({ targetRelpath: 'Manual.azw3' })
    expect(existsSync(documents('Manual.azw3'))).toBe(true)
  })
})

describe('library folders', () => {
  test('a folder is linked only when the user picks one in the system dialog', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await invokeIpc('library:add-folder')).toBeNull()

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/Books'] })
    await invokeIpc('library:add-folder')

    expect(folderWatching.link).toHaveBeenCalledWith('/Users/me/Books')
  })

  test('unlinking and syncing go to the folder runtime; the list comes from the store', async () => {
    await invokeIpc('library:remove-folder', 'f1')
    await invokeIpc('library:sync-folders')

    expect(folderWatching.forget).toHaveBeenCalledWith('f1')
    expect(folderWatching.syncAll).toHaveBeenCalled()
    expect(await invokeIpc('library:list-folders')).toEqual([])
  })
})

describe('app channels', () => {
  test('report the version and the conversion format', async () => {
    expect(await invokeIpc('kindle:get-app-version')).toBe('0.0.0')
    expect(await invokeIpc('kindle:get-format')).toBe('azw3')
  })

  test('an update check that cannot reach GitHub offers nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))

    expect(await invokeIpc('kindle:check-for-update')).toBeNull()
    vi.unstubAllGlobals()
  })

  test('a logs folder that cannot be opened is an error, not silence', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Failed to open')

    await expect(invokeIpc('kindle:open-logs-folder')).rejects.toThrow('Failed to open')
  })

  test('the cover and menu channels validate and pass through', async () => {
    await invokeIpc('kindle:set-locale', 'it')
    await invokeIpc('kindle:cancel-cover', 'Dune', undefined, undefined)
    await invokeIpc('menu:set-labels', 'Informazioni', 'Scopri di più')
    await invokeIpc('menu:popup', 10, 20)

    await expect(invokeIpc('kindle:ensure-cover', 'Dune', 3)).rejects.toBeInstanceOf(TypeError)
  })
})
