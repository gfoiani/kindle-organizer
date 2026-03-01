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
  extension: string
  size: number
  path: string
}

export interface Collection {
  id: string
  name: string
  bookCount: number
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

export async function readDocuments(kindleMountpoint: string): Promise<KindleBook[]> {
  const documentsPath = path.join(kindleMountpoint, 'documents')

  const exists = await fs.pathExists(documentsPath)
  if (!exists) {
    return []
  }

  const entries = await fs.readdir(documentsPath, { withFileTypes: true })
  const books: KindleBook[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue

    const ext = path.extname(entry.name).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue

    const filePath = path.join(documentsPath, entry.name)
    const stats = await fs.stat(filePath)

    books.push({
      filename: entry.name,
      title: path.basename(entry.name, ext),
      extension: ext.replace('.', '').toUpperCase(),
      size: stats.size,
      path: filePath
    })
  }

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
      bookCount: row.bookCount
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
