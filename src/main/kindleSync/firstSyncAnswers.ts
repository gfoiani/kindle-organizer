import type Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { createCachedDb } from '../sqlite'

/**
 * The first-sync answer per Kindle (the component's `deviceId` from
 * `status.json`): until it is recorded the app writes `desired.json` in `hold`
 * mode, keeps importing calibre tags on connect, and asks the question.
 */

export type FirstSyncAnswer = 'import' | 'discard'

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'kindle-sync.db')
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS first_sync (
      device_id   TEXT PRIMARY KEY,
      answer      TEXT NOT NULL CHECK (answer IN ('import', 'discard')),
      answered_at INTEGER NOT NULL
    )
  `)
}

const store = createCachedDb(getDbPath, initSchema)

/** Closes the kindle-sync DB handle. Called from `will-quit`. */
export function closeKindleSyncDb(): void {
  store.close()
}

export function getFirstSyncAnswer(deviceId: string): FirstSyncAnswer | null {
  const row = store
    .get()
    .prepare<[string], { answer: FirstSyncAnswer }>('SELECT answer FROM first_sync WHERE device_id = ?')
    .get(deviceId)
  return row?.answer ?? null
}

export function recordFirstSyncAnswer(deviceId: string, answer: FirstSyncAnswer, now = Date.now()): void {
  store
    .get()
    .prepare<[string, string, number]>('INSERT OR REPLACE INTO first_sync (device_id, answer, answered_at) VALUES (?, ?, ?)')
    .run(deviceId, answer, now)
}
