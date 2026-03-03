import si from 'systeminformation'
import * as fs from 'fs-extra'
import Database from 'better-sqlite3'
import path from 'path'

export interface KindleDrive {
  device: string
  mountpoint: string
  description: string
  size: number
  isReadOnly: boolean
}

export interface KindleBook {
  filename: string
  title: string
  author?: string
  extension: string
  size: number
  path: string
}

export interface Collection {
  id: string
  name: string
  bookCount: number
  source: 'calibre' | 'local'
}

export interface CollectionItem {
  collectionId: string
  bookPath: string
}

const KINDLE_IDENTIFIERS = ['kindle', 'amazon']
const SUPPORTED_EXTENSIONS = ['.mobi', '.azw', '.azw3', '.kfx', '.epub', '.pdf']

export async function detectKindleDrives(): Promise<KindleDrive[]> {
  const devices = await si.blockDevices()

  return devices
    .filter((device) => {
      if (!device.mount) return false
      const label = (device.label || '').toLowerCase()
      const model = (device.model || '').toLowerCase()
      const combined = `${label} ${model}`
      return KINDLE_IDENTIFIERS.some((id) => combined.includes(id))
    })
    .map((device) => ({
      device: device.name,
      mountpoint: device.mount,
      description: device.label || device.model || device.name,
      size: device.size,
      isReadOnly: false
    }))
}

const JUNK_EXTENSIONS = ['.sdr']

// Calibre sort-articles: checked longest-first to avoid partial matches.
// Calibre inverts articles for sorting: "Gli androidi..." → filename "androidi..., Gli"
const SORT_ARTICLES = [
  'Gli', 'Les', 'Une', 'Das', 'Der', 'Die', 'Ein', 'Eine',
  "L'", "Un'", 'Una', 'Uno', 'The',
  'La', 'Le', 'Lo', 'Un', 'Il',
  'An', 'I', 'A',
]

function sanitizeTitle(filename: string, author?: string): string {
  let t = filename

  // 1. Replace underscores with spaces
  t = t.replace(/_/g, ' ')

  // 2. Remove Amazon ASIN at end: space + B + digit + 8 alphanumeric chars
  t = t.replace(/\s+B[0-9][A-Z0-9]{8}$/i, '')

  // 3. Strip " - Author" suffix (Calibre stores "Title - Author" in filenames)
  if (author) {
    const parts = author.split(',').map((s) => s.trim()).filter(Boolean)
    const variants = [
      author,                                                  // "Last, First"
      parts.join(' '),                                         // "Last First"
      parts.length === 2 ? `${parts[1]} ${parts[0]}` : '',    // "First Last"
    ].filter(Boolean)

    const lastDash = t.lastIndexOf(' - ')
    if (lastDash !== -1) {
      const afterDash = t.slice(lastDash + 3).toLowerCase()
      for (const variant of variants) {
        const v = variant.toLowerCase()
        // Exact match or multi-author prefix ("First Last, CoAuthor")
        if (afterDash === v || afterDash.startsWith(v + ',')) {
          t = t.slice(0, lastDash)
          break
        }
      }
    }
  }

  // 4. Restore Calibre article inversion: "title, Gli" / "title  Gli" → "Gli title"
  for (const article of SORT_ARTICLES) {
    const pattern = new RegExp(`(?:,\\s+|\\s{2,})${article}\\s*$`)
    if (pattern.test(t)) {
      const base = t.replace(pattern, '').replace(/[.,]+$/, '').trimEnd()
      // Articles ending with apostrophe elide directly (L'arte), others add space
      t = article.endsWith("'") ? `${article}${base}` : `${article} ${base}`
      break
    }
  }

  // 5. Collapse multiple spaces, trim trailing punctuation
  t = t.replace(/\s{2,}/g, ' ').replace(/[.,\s]+$/, '').trim()

  // 6. Capitalize first letter if lowercase
  if (t.length > 0 && t[0] >= 'a' && t[0] <= 'z') {
    t = t[0].toUpperCase() + t.slice(1)
  }

  return t
}

async function scanBooks(dirPath: string, author?: string): Promise<KindleBook[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const books: KindleBook[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    if (entry.isDirectory()) {
      if (JUNK_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue
      const subBooks = await scanBooks(path.join(dirPath, entry.name), entry.name)
      books.push(...subBooks)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue

      const filePath = path.join(dirPath, entry.name)
      const stats = await fs.stat(filePath)

      books.push({
        filename: entry.name,
        title: sanitizeTitle(path.basename(entry.name, ext), author),
        author,
        extension: ext.replace('.', '').toUpperCase(),
        size: stats.size,
        path: filePath
      })
    }
  }

  return books
}

export async function readDocuments(kindleMountpoint: string): Promise<KindleBook[]> {
  const documentsPath = path.join(kindleMountpoint, 'documents')

  const exists = await fs.pathExists(documentsPath)
  if (!exists) {
    return []
  }

  const books = await scanBooks(documentsPath)
  return books.sort((a, b) => a.title.localeCompare(b.title))
}

export function queryCollections(dbPath: string): Collection[] {
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const db = new Database(dbPath, { readonly: true })

  try {
    const rows = db
      .prepare(
        `
        SELECT
          p_uuid AS id,
          p_title AS name,
          COUNT(i_uuid) AS bookCount
        FROM Collection
        LEFT JOIN CollectionEntry ON Collection.p_uuid = CollectionEntry.p_collection
        GROUP BY Collection.p_uuid, Collection.p_title
        ORDER BY Collection.p_title
      `
      )
      .all() as Array<{ id: string; name: string; bookCount: number }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      bookCount: row.bookCount,
      source: 'local' as const
    }))
  } finally {
    db.close()
  }
}

export function queryCollectionItems(dbPath: string, collectionId: string): CollectionItem[] {
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const db = new Database(dbPath, { readonly: true })

  try {
    const rows = db
      .prepare(
        `
        SELECT
          p_collection AS collectionId,
          i_member AS bookPath
        FROM CollectionEntry
        WHERE p_collection = ?
      `
      )
      .all(collectionId) as Array<{ collectionId: string; bookPath: string }>

    return rows.map((row) => ({
      collectionId: row.collectionId,
      bookPath: row.bookPath
    }))
  } finally {
    db.close()
  }
}
