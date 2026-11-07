import { foldRelpath } from '../paths'

/**
 * Turns the app's collections into the flat collections a Kindle can hold.
 *
 * Kindle collections cannot nest. The app encodes a sub-collection in its
 * name ("Giallo / Cooper, Glenn", see the renderer's `collectionHierarchy`), so
 * every app collection is filed under the part before the first separator: the
 * Kindle gets "Giallo" holding the books of "Giallo" and of all its
 * sub-collections. Only books on this device are kept, and a collection left
 * with none is not planned at all (the design skips empty collections).
 *
 * The output is sorted and duplicate-free, so the same state always gives the
 * same plan — the device compares a hash of it to decide whether to run.
 */

/** Must equal the renderer's `SUBCOLLECTION_SEPARATOR` (a test checks it). */
export const KINDLE_COLLECTION_SEPARATOR = ' / '

/** An app collection with the book keys (relpaths under `documents/`) it holds. */
export interface AppCollectionMembers {
  readonly name: string
  readonly relpaths: readonly string[]
}

/** A collection as it should exist on the Kindle. */
export interface PlannedKindleCollection {
  name: string
  /** Relpaths under `documents/`, spelled as on the device, sorted. */
  relpaths: string[]
}

interface Group {
  name: string
  /** Whether `name` comes from a real top-level collection (it then wins). */
  fromTopLevel: boolean
  relpaths: ReadonlySet<string>
}

function topLevelName(name: string): string {
  const separatorAt = name.indexOf(KINDLE_COLLECTION_SEPARATOR)
  const head = separatorAt === -1 ? name : name.slice(0, separatorAt)
  return head.replace(/\s+/g, ' ').trim()
}

function mergeInto(groups: ReadonlyMap<string, Group>, name: string, fromTopLevel: boolean, relpaths: readonly string[]): Map<string, Group> {
  const key = name.toLowerCase()
  const existing = groups.get(key)
  const keepExistingName = existing !== undefined && (existing.fromTopLevel || !fromTopLevel)
  const merged: Group = {
    name: keepExistingName ? existing.name : name,
    fromTopLevel: fromTopLevel || (existing?.fromTopLevel ?? false),
    relpaths: new Set([...(existing?.relpaths ?? []), ...relpaths])
  }
  return new Map(groups).set(key, merged)
}

export function planKindleCollections(
  collections: readonly AppCollectionMembers[],
  deviceRelpaths: readonly string[]
): PlannedKindleCollection[] {
  const onDevice = new Map(deviceRelpaths.map((relpath) => [foldRelpath(relpath), relpath]))

  const groups = collections.reduce<Map<string, Group>>((acc, collection) => {
    const name = topLevelName(collection.name)
    if (!name) return acc
    const isTopLevel = !collection.name.includes(KINDLE_COLLECTION_SEPARATOR)
    const present = collection.relpaths.flatMap((relpath) => {
      const deviceSpelling = onDevice.get(foldRelpath(relpath))
      return deviceSpelling === undefined ? [] : [deviceSpelling]
    })
    return mergeInto(acc, name, isTopLevel, present)
  }, new Map())

  return [...groups.values()]
    .filter((group) => group.relpaths.size > 0)
    .map((group) => ({ name: group.name, relpaths: [...group.relpaths].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
