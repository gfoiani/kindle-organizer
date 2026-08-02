import Database from 'better-sqlite3'

/**
 * A lazily-opened, cached SQLite connection.
 *
 * The stores used to open a fresh connection — and re-run their whole
 * `CREATE TABLE IF NOT EXISTS` schema — on EVERY call. That is invisible for a
 * one-shot read but pathological for batch work: applying AI suggestions to 500
 * books meant 500 open/init/close cycles. Holding one handle collapses that to a
 * single open for the process lifetime.
 *
 * The handle is keyed on the resolved file path and re-checked on every `get()`.
 * The app itself never changes `userData`, but the Vitest harness swaps it per
 * test (`freshUserData()`); without the check a cached handle would keep reading
 * and writing the PREVIOUS test's database. Re-resolving is a cheap string
 * compare, so correctness here costs nothing.
 */
export interface CachedDb {
  /** The open connection, opening it (and applying the schema) on first use. */
  get: () => Database.Database
  /** Closes the handle if open. Idempotent; call from `will-quit`. */
  close: () => void
}

export function createCachedDb(
  resolvePath: () => string,
  initSchema: (db: Database.Database) => void
): CachedDb {
  let db: Database.Database | null = null
  let openPath: string | null = null

  return {
    get(): Database.Database {
      const dbPath = resolvePath()

      // Retire a handle pointing at a different file rather than silently
      // operating on the wrong database.
      if (db && openPath !== dbPath) {
        db.close()
        db = null
        openPath = null
      }

      if (!db) {
        const opened = new Database(dbPath)
        opened.pragma('journal_mode = WAL')
        opened.pragma('foreign_keys = ON')
        initSchema(opened)
        db = opened
        openPath = dbPath
      }

      return db
    },

    close(): void {
      if (db) {
        db.close()
        db = null
        openPath = null
      }
    }
  }
}
