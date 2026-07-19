import * as crypto from 'crypto'
import * as path from 'path'
import { app } from 'electron'

/**
 * Single source of truth for the on-disk cover cache layout and cache key.
 *
 * Shared by `covers.ts` (which writes the files) and `coverProtocol.ts` (which
 * streams them back to the renderer). Keeping the key derivation here — instead
 * of duplicating it in a renderer mirror — means the renderer never recomputes
 * it: `ensureCover` returns the key and every consumer carries it along.
 *
 * IMPORTANT (back-compat): do NOT "improve" the normalization below. The key is
 * byte-identical to the historical scheme for books without an ISBN, so existing
 * `<hash>.jpg` files stay valid. Any change orphans the entire on-disk cache.
 */

/** `<userData>/covers` — the cover cache directory. */
export function getCoverCacheDir(): string {
  return path.join(app.getPath('userData'), 'covers')
}

/** Absolute path of the cached JPEG for a cache key. */
export function getCachePath(key: string): string {
  return path.join(getCoverCacheDir(), `${key}.jpg`)
}

/**
 * Normalizes a raw ISBN; returns it only if it looks like an ISBN-10/13.
 * Lives here (not covers.ts) so `getCacheKey` can fold it into the key without a
 * circular import.
 */
export function normalizeIsbn(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase()
  return cleaned.length === 10 || cleaned.length === 13 ? cleaned : undefined
}

/**
 * sha256 of the book identity.
 *
 * Back-compat is load-bearing: books WITHOUT a usable ISBN hash to exactly the
 * historical `title|author` string (two fields, one pipe) so every existing
 * `<hash>.jpg` on disk stays valid. Only when a valid ISBN is present do we
 * append a third `|isbn` segment, yielding a distinct key (one self-healing
 * re-download the first time that book is accessed). Appending an empty segment
 * unconditionally (`title|author|`) would change the hash for ALL books and
 * orphan the whole cache — do not do that.
 */
export function getCacheKey(title: string, author: string | undefined, isbn?: string): string {
  const base = `${title.toLowerCase().trim()}|${(author ?? '').toLowerCase().trim()}`
  const isbnPart = normalizeIsbn(isbn)
  const normalized = isbnPart ? `${base}|${isbnPart}` : base
  return crypto.createHash('sha256').update(normalized).digest('hex')
}
