import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'

// A folder on a dead network share or hung USB disk never answers: these mocks
// let a test make one read hang forever.
vi.mock('../src/main/folderScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/folderScan')>()
  return { ...actual, scanLibraryFolder: vi.fn(actual.scanLibraryFolder), isReadableDirectory: vi.fn(actual.isReadableDirectory) }
})
vi.mock('../src/main/libraryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/libraryService')>()
  return { ...actual, hashFile: vi.fn(actual.hashFile) }
})

const { isReadableDirectory, scanLibraryFolder } = await import('../src/main/folderScan')
const { hashFile } = await import('../src/main/libraryService')
const { addLibraryFolder, configureSyncDeadlines, describeLibraryFolders, syncAllLibraryFolders, syncLibraryFolder } =
  await import('../src/main/libraryFolders')
const { listFolderBooks } = await import('../src/main/library')

const DEADLINE_MS = 50
const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

let scratch: string

beforeEach(() => {
  freshUserData()
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'library-deadline-')))
  configureSyncDeadlines({ scanMs: DEADLINE_MS, readMs: DEADLINE_MS })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

afterAll(() => {
  cleanupUserDataDirs()
})

function folderWith(name: string, files: string[]): string {
  const dir = path.join(scratch, name)
  mkdirSync(dir)
  for (const file of files) writeFileSync(path.join(dir, file), file)
  return dir
}

describe('library folders that stop answering', () => {
  test('a folder whose scan hangs is reported unavailable, and the other folders still sync', async () => {
    // Arrange
    const hung = await addLibraryFolder(folderWith('Hung', ['a.azw3']))
    const healthy = await addLibraryFolder(folderWith('Healthy', ['b.azw3']))
    vi.mocked(scanLibraryFolder).mockImplementationOnce(() => never())

    // Act
    const results = await syncAllLibraryFolders()

    // Assert
    expect(results.find((r) => r.folderId === hung.id)?.status).toBe('unavailable')
    expect(results.find((r) => r.folderId === healthy.id)).toMatchObject({ status: 'ok', added: 1 })
  })

  test('a file whose read hangs counts as an error and does not block the queue', async () => {
    // Arrange
    const folder = await addLibraryFolder(folderWith('Books', ['a.azw3']))
    vi.mocked(hashFile).mockImplementationOnce(() => never())

    // Act
    const first = await syncLibraryFolder(folder.id)
    const second = await syncLibraryFolder(folder.id)

    // Assert
    expect(first).toMatchObject({ added: 0, errors: 1 })
    expect(second).toMatchObject({ added: 1, errors: 0 })
    expect(listFolderBooks(folder.id)).toHaveLength(1)
  })

  test('a folder that does not answer is described as unreachable instead of hanging the panel', async () => {
    await addLibraryFolder(folderWith('Books', []))
    vi.mocked(isReadableDirectory).mockImplementationOnce(() => never())

    const [summary] = await describeLibraryFolders()

    expect(summary.available).toBe(false)
  })
})
