import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData, invokeIpc } from './setup/electron-mock'

vi.mock('systeminformation', () => ({ default: { blockDevices: vi.fn() } }))

import si from 'systeminformation'
import { registerIpcHandlers } from '../src/main/ipc'
import type { LibraryFolderWatching } from '../src/main/libraryWatcher'
import type { Collection } from '../src/main/kindle'

/**
 * The collection sync with a jailbroken Kindle, driven through IPC the way the
 * renderer drives it, against a temp directory standing for the Kindle.
 */

type BlockDevice = Awaited<ReturnType<typeof si.blockDevices>>[number]
const blockDevices = vi.mocked(si.blockDevices)

const JBSH_MARKER = 'You are jailbroken!\n(jb.sh v2.5.0)\nhttps://kindlemodding.org\n'

const STATUS = {
  schema: 1,
  deviceId: 'kt5-ab12',
  componentVersion: '1.0.0',
  finishedAt: '2026-11-07T18:30:00Z',
  result: 'installed',
  created: 0,
  updated: 0,
  deleted: 0,
  pendingBooks: []
}

let mountpoint: string

function connectKindle(): string {
  const mount = mkdtempSync(path.join(tmpdir(), 'ipc-sync-kindle-'))
  mkdirSync(path.join(mount, 'documents'))
  blockDevices.mockResolvedValue([{ name: 'disk4', mount, label: 'Kindle', model: '', size: 1 } as BlockDevice])
  return mount
}

function addBook(relpath: string): void {
  const file = path.join(mountpoint, 'documents', relpath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'book')
}

function jailbreak(marker = JBSH_MARKER): void {
  writeFileSync(path.join(mountpoint, 'documents', 'JAILBROKEN.txt'), marker)
}

function syncFile(name: string): string {
  return path.join(mountpoint, 'kindle-organizer', name)
}

function writeSyncFile(name: string, content: unknown): void {
  mkdirSync(path.join(mountpoint, 'kindle-organizer'), { recursive: true })
  writeFileSync(syncFile(name), JSON.stringify(content))
}

/** A jb.sh Kindle whose component has run once. */
function installComponent(exportedCollections: unknown[] = []): void {
  jailbreak()
  writeSyncFile('status.json', STATUS)
  writeSyncFile('export.json', { schema: 1, collections: exportedCollections })
}

function readDesired(): { mode: string; collections: Array<{ name: string; members: string[] }> } {
  return JSON.parse(readFileSync(syncFile('desired.json'), 'utf8'))
}

async function appCollections(): Promise<Collection[]> {
  return (await invokeIpc('kindle:get-local-collections')) as Collection[]
}

beforeAll(() => {
  registerIpcHandlers({ refresh: vi.fn(), link: vi.fn(), forget: vi.fn(), syncAll: vi.fn(), stop: vi.fn() } as unknown as LibraryFolderWatching)
})

beforeEach(() => {
  freshUserData()
  blockDevices.mockReset()
  mountpoint = connectKindle()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('kindle-sync:refresh', () => {
  test('a Kindle without a jailbreak is reported as such and nothing is written to it', async () => {
    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toEqual({ kind: 'not-jailbroken' })
    expect(existsSync(path.join(mountpoint, 'kindle-organizer'))).toBe(false)
  })

  test('a jailbreak other than jb.sh is reported as unsupported', async () => {
    jailbreak('You are jailbroken!\n')

    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toEqual({ kind: 'unsupported-jailbreak' })
  })

  test('a jb.sh Kindle without the component is reported as not installed and nothing is written', async () => {
    jailbreak()

    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toEqual({ kind: 'not-installed' })
    expect(existsSync(path.join(mountpoint, 'kindle-organizer'))).toBe(false)
  })

  test('before the first-sync answer: the Kindle collections are shown and the desired state is held', async () => {
    // Arrange
    addBook('A/One.azw3')
    installComponent([{ name: 'Letti', members: ['A/One.azw3'], otherMembers: 2 }])
    const giallo = (await invokeIpc('kindle:create-collection', 'Giallo')) as Collection
    await invokeIpc('kindle:add-book-to-collection', giallo.id, 'A/One.azw3')

    // Act
    const state = await invokeIpc('kindle-sync:refresh', mountpoint)

    // Assert
    expect(state).toEqual({ kind: 'first-sync', status: STATUS, kindleCollections: [{ name: 'Letti', bookCount: 3 }] })
    expect(readDesired()).toMatchObject({ mode: 'hold', collections: [{ name: 'Giallo', members: ['A/One.azw3'] }] })
  })

  test('an unreadable export is reported as such, not as a Kindle with no collections', async () => {
    installComponent()
    writeFileSync(syncFile('export.json'), '{broken')

    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toMatchObject({ kind: 'first-sync', kindleCollections: null })
  })

  test('refuses a path detection does not report as a Kindle', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'ipc-sync-elsewhere-'))

    await expect(invokeIpc('kindle-sync:refresh', elsewhere)).rejects.toThrow('DEVICE_NOT_FOUND')
  })
})

describe('kindle-sync:answer-first-sync', () => {
  test('import: the Kindle collections become app collections, then the app collections are mirrored', async () => {
    // Arrange
    addBook('A/One.azw3')
    installComponent([
      { name: 'Letti', members: ['a/one.azw3'], otherMembers: 0 },
      { name: 'Acquisti', members: [], otherMembers: 4 }
    ])

    // Act
    const state = await invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'import')

    // Assert
    expect(state).toEqual({ kind: 'active', status: STATUS })
    expect((await appCollections()).map((c) => [c.name, c.bookCount])).toEqual([
      ['Acquisti', 0],
      ['Letti', 1]
    ])
    expect(readDesired()).toMatchObject({
      mode: 'mirror',
      collections: [
        { name: 'Acquisti', members: [] },
        { name: 'Letti', members: ['A/One.azw3'] }
      ]
    })
  })

  test('discard: nothing is imported and the app collections are mirrored', async () => {
    addBook('A/One.azw3')
    installComponent([{ name: 'Letti', members: ['A/One.azw3'], otherMembers: 0 }])

    await invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'discard')

    expect(await appCollections()).toEqual([])
    expect(readDesired()).toMatchObject({ mode: 'mirror', collections: [] })
  })

  test('the answer is remembered: the next refresh is active and keeps mirroring', async () => {
    installComponent()
    await invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'discard')

    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toEqual({ kind: 'active', status: STATUS })
    expect(readDesired().mode).toBe('mirror')
  })

  test('import is refused while the export cannot be read, and nothing is remembered', async () => {
    installComponent()
    writeFileSync(syncFile('export.json'), '{broken')

    await expect(invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'import')).rejects.toThrow('KINDLE_SYNC_EXPORT_UNREADABLE')
    expect(await invokeIpc('kindle-sync:refresh', mountpoint)).toMatchObject({ kind: 'first-sync' })
  })

  test('is refused on a Kindle without the component', async () => {
    jailbreak()

    await expect(invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'discard')).rejects.toThrow('KINDLE_SYNC_NOT_INSTALLED')
  })

  test('rejects an answer that is not import or discard', async () => {
    installComponent()

    await expect(invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'wipe')).rejects.toThrow(TypeError)
  })
})

describe('calibre tags are imported on connect until the first-sync answer', () => {
  function writeCalibreTags(): void {
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), JSON.stringify([{ lpath: 'documents/A/One.azw3', tags: ['Fantasy'] }]))
  }

  test('a jb.sh Kindle that has not answered still imports them', async () => {
    addBook('A/One.azw3')
    installComponent()
    writeCalibreTags()

    await invokeIpc('kindle:sync-calibre', mountpoint)

    expect((await appCollections()).map((c) => c.name)).toEqual(['Fantasy'])
  })

  test('once the answer is given, connecting no longer imports them', async () => {
    addBook('A/One.azw3')
    installComponent()
    await invokeIpc('kindle-sync:answer-first-sync', mountpoint, 'discard')
    writeCalibreTags()

    await invokeIpc('kindle:sync-calibre', mountpoint)

    expect(await appCollections()).toEqual([])
  })
})

test('the old "write collections to metadata.calibre" channel is gone', async () => {
  await expect(invokeIpc('kindle:write-to-kindle', mountpoint)).rejects.toThrow('No IPC handler registered')
})
