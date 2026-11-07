import { foldRelpath } from '../paths'
import type { CollectionMembership } from '../localCollections'
import { KINDLE_COLLECTION_SEPARATOR } from './plan'
import type { DeviceExport } from './syncFiles'

/**
 * The first-sync import: the Kindle's own collections (from `export.json`)
 * as app collections.
 *
 * - Members are matched to the books the app lists on the device (FAT is
 *   case-insensitive, macOS may decompose names) and spelled as the app keys
 *   them; members the app does not list are left out — they stay on the Kindle
 *   anyway, the mirror only manages books the app can see.
 * - A collection left with no members is still imported: the user asked to keep
 *   it, and the mirror keeps an existing collection the app wants.
 * - A name carrying the app's sub-collection separator is kept a plain name
 *   (" / " → " - "), and one matching an existing app collection, ignoring
 *   case, joins it.
 */

const SEPARATOR_REPLACEMENT = ' - '

function importedName(raw: string): string {
  return raw.split(KINDLE_COLLECTION_SEPARATOR).join(SEPARATOR_REPLACEMENT).replace(/\s+/g, ' ').trim()
}

export function planKindleImport(
  exported: DeviceExport,
  deviceRelpaths: readonly string[],
  existingNames: readonly string[]
): CollectionMembership[] {
  const onDevice = new Map(deviceRelpaths.map((relpath) => [foldRelpath(relpath), relpath]))
  const existing = new Map(existingNames.map((name) => [name.toLowerCase(), name]))

  const merged = exported.collections.reduce<ReadonlyMap<string, CollectionMembership>>((acc, collection) => {
    const name = importedName(collection.name)
    if (!name) return acc
    const key = name.toLowerCase()
    const present = collection.members.flatMap((member) => onDevice.get(foldRelpath(member)) ?? [])
    const previous = acc.get(key)
    const entry: CollectionMembership = {
      name: previous?.name ?? existing.get(key) ?? name,
      relpaths: [...new Set([...(previous?.relpaths ?? []), ...present])].sort()
    }
    return new Map(acc).set(key, entry)
  }, new Map())

  return [...merged.values()]
}
