import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { createFolderWatchers, startLibraryFolderWatching, type WatchFn } from '../src/main/libraryWatcher'
import { addLibraryFolder } from '../src/main/libraryFolders'
import { listFolderBooks, type LibraryFolder } from '../src/main/library'

interface FakeWatcher {
  dir: string
  emit: (filename: string | null) => void
  fail: (err: unknown) => void
  closed: boolean
}

/** A stand-in for fs.watch that the test drives by hand. */
function fakeWatch(): { watch: WatchFn; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = []
  const watch: WatchFn = (dir, onEvent, onError) => {
    const watcher: FakeWatcher = { dir, emit: onEvent, fail: onError, closed: false }
    watchers.push(watcher)
    return {
      close: () => {
        watcher.closed = true
      }
    }
  }
  return { watch, watchers }
}

function folder(id: string, folderPath = `/books/${id}`): LibraryFolder {
  return { id, path: folderPath, addedAt: 1 }
}

describe('createFolderWatchers', () => {
  const DEBOUNCE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('a burst of events becomes one change once the folder is quiet', () => {
    // Arrange
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a')])

    // Act
    fake.watchers[0].emit('book.epub')
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    fake.watchers[0].emit('book.epub')
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)

    // Assert: still copying, nothing yet.
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('a')
  })

  test('events on hidden files are ignored, nameless events are not', () => {
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a')])

    fake.watchers[0].emit('.DS_Store')
    fake.watchers[0].emit(path.join('Sub', '.hidden.epub'))
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(onChange).not.toHaveBeenCalled()

    fake.watchers[0].emit(null)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(onChange).toHaveBeenCalledOnce()
  })

  test('each folder settles on its own', () => {
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a'), folder('b')])

    fake.watchers[0].emit('x.epub')
    fake.watchers[1].emit('y.epub')
    vi.advanceTimersByTime(DEBOUNCE_MS)

    expect(onChange.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
  })

  test('watching the same folders again keeps the running watchers', () => {
    const fake = fakeWatch()
    const watchers = createFolderWatchers(vi.fn(), { watch: fake.watch, debounceMs: DEBOUNCE_MS })

    watchers.watch([folder('a')])
    watchers.watch([folder('a')])

    expect(fake.watchers).toHaveLength(1)
    expect(fake.watchers[0].closed).toBe(false)
  })

  test('a folder dropped from the list stops being watched, pending change included', () => {
    // Arrange
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a'), folder('b')])
    fake.watchers[0].emit('x.epub')

    // Act
    watchers.watch([folder('b')])
    vi.advanceTimersByTime(DEBOUNCE_MS)

    // Assert
    expect(fake.watchers[0].closed).toBe(true)
    expect(fake.watchers[1].closed).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('a watcher that fails is closed, reports a change and is re-armed by the next watch()', () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a')])

    // Act: e.g. the disk holding the folder was unplugged.
    fake.watchers[0].fail(new Error('EPERM'))
    vi.advanceTimersByTime(DEBOUNCE_MS)
    watchers.watch([folder('a')])

    // Assert
    expect(fake.watchers[0].closed).toBe(true)
    expect(onChange).toHaveBeenCalledWith('a')
    expect(fake.watchers).toHaveLength(2)
    expect(fake.watchers[1].closed).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('a folder that cannot be watched is logged and retried on the next watch()', () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeWatch()
    let attempts = 0
    const flaky: WatchFn = (dir, onEvent, onError) => {
      attempts += 1
      if (attempts === 1) throw new Error('ENOENT')
      return fake.watch(dir, onEvent, onError)
    }
    const watchers = createFolderWatchers(vi.fn(), { watch: flaky, debounceMs: DEBOUNCE_MS })

    // Act
    expect(() => watchers.watch([folder('a')])).not.toThrow()
    watchers.watch([folder('a')])

    // Assert
    expect(attempts).toBe(2)
    expect(fake.watchers).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('close() closes every watcher and cancels pending changes', () => {
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watchers = createFolderWatchers(onChange, { watch: fake.watch, debounceMs: DEBOUNCE_MS })
    watchers.watch([folder('a'), folder('b')])
    fake.watchers[0].emit('x.epub')

    watchers.close()
    vi.advanceTimersByTime(DEBOUNCE_MS)

    expect(fake.watchers.every((w) => w.closed)).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('startLibraryFolderWatching', () => {
  let scratch: string

  beforeEach(() => {
    freshUserData()
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'library-watch-')))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  afterAll(() => {
    cleanupUserDataDirs()
  })

  test('a change in a watched folder is synced and announced', async () => {
    // Arrange
    const root = path.join(scratch, 'Books')
    mkdirSync(root)
    const linked = await addLibraryFolder(root)
    const fake = fakeWatch()
    const notify = vi.fn()
    const watching = startLibraryFolderWatching(notify, { watch: fake.watch, debounceMs: 5 })
    watching.refresh()

    // Act
    writeFileSync(path.join(root, 'new.azw3'), 'bytes')
    fake.watchers[0].emit('new.azw3')

    // Assert
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(listFolderBooks(linked.id).map((b) => b.filename)).toEqual(['new.azw3'])
    watching.stop()
    expect(fake.watchers[0].closed).toBe(true)
  })

  test('syncAll announces only when something changed, and re-arms the watchers', async () => {
    // Arrange
    const root = path.join(scratch, 'Books')
    mkdirSync(root)
    await addLibraryFolder(root)
    const fake = fakeWatch()
    const notify = vi.fn()
    const watching = startLibraryFolderWatching(notify, { watch: fake.watch, debounceMs: 5 })

    // Act
    const quiet = await watching.syncAll()
    writeFileSync(path.join(root, 'new.azw3'), 'bytes')
    const busy = await watching.syncAll()

    // Assert
    expect(quiet.map((r) => r.added)).toEqual([0])
    expect(busy.map((r) => r.added)).toEqual([1])
    expect(notify).toHaveBeenCalledOnce()
    expect(fake.watchers).toHaveLength(1)
    watching.stop()
  })
})
