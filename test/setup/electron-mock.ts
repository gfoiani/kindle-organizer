import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { vi } from 'vitest'

/**
 * Mocks the `electron` module so main-process modules (which do
 * `import { app } from 'electron'`) can be imported and exercised under Vitest.
 *
 * `app.getPath('userData')` returns the CURRENT per-test temp directory. Tests
 * call `freshUserData()` in `beforeEach` to get an isolated SQLite store, so the
 * `localCollections` / `bookOverrides` DBs never leak state across tests or
 * touch a real user profile.
 */
let currentUserData = mkdtempSync(path.join(tmpdir(), 'kindle-organizer-test-'))
const createdDirs: string[] = [currentUserData]

/** Points `app.getPath('userData')` at a brand-new empty temp dir; returns it. */
export function freshUserData(): string {
  currentUserData = mkdtempSync(path.join(tmpdir(), 'kindle-organizer-test-'))
  createdDirs.push(currentUserData)
  return currentUserData
}

/** Best-effort cleanup of every temp userData dir created during the run. */
export function cleanupUserDataDirs(): void {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0',
    getPath: (name: string) => {
      if (name === 'userData') return currentUserData
      return path.join(currentUserData, name)
    }
  }
}))
