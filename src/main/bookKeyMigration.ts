import type Database from 'better-sqlite3'
import { canonicalBookKey } from './paths'

/** A column of book keys. Both names are constants of the store that owns the table, never input. */
export interface BookKeyColumn {
  table: string
  column: string
}

/**
 * Rewrites the book keys an older version stored into their current form
 * (`canonicalBookKey`): on Windows the whole `E:\documents\…` path, on macOS
 * sometimes a decomposed name. When the current form is already stored for the
 * same row (the key's other spelling was saved too), that row is kept and the
 * old one dropped.
 *
 * Called whenever a store opens. Once every key is current it only reads them.
 * Returns how many keys were rewritten.
 */
export function migrateBookKeys(db: Database.Database, { table, column }: BookKeyColumn): number {
  const keys = db.prepare<[], string>(`SELECT DISTINCT ${column} FROM ${table}`).pluck().all()
  const stale = keys.flatMap((key): [string, string][] => {
    const current = canonicalBookKey(key)
    return current === key ? [] : [[key, current]]
  })
  if (stale.length === 0) return 0

  const rename = db.prepare<[string, string]>(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`)
  const drop = db.prepare<[string]>(`DELETE FROM ${table} WHERE ${column} = ?`)
  db.transaction(() => {
    for (const [old, current] of stale) {
      rename.run(current, old)
      drop.run(old)
    }
  })()
  console.warn(`[${table}] rewrote ${stale.length} book key(s) stored by an older version`)
  return stale.length
}
