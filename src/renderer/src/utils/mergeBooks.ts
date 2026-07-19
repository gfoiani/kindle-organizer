import type { KindleBook, LibraryBook } from '../../../preload/api'
import { toBookRelpath } from './relpath'

/** Transient send-to-Kindle state layered onto a card while a send is running. */
export type BookConversionState = 'converting' | 'uploading' | 'error'

/**
 * A card shown in the grid. Every device book and every unreconciled library
 * book becomes one. `onDevice` drives the presence badge; `libraryId` links the
 * card to its staging-library entry (enabling send/remove); `conversionStatus`
 * is layered on transiently while a send is in flight.
 */
export interface DisplayBook extends KindleBook {
  onDevice: boolean
  libraryId?: string
  conversionStatus?: BookConversionState
}

/** Normalizes a title|author pair into a stable reconciliation key. */
function identityKey(title: string, author: string | undefined): string {
  return `${title.trim().toLowerCase()}|${(author ?? '').trim().toLowerCase()}`
}

/** Builds a library-only card: no device file, so path/size are placeholders. */
function libraryToDisplay(lib: LibraryBook): DisplayBook {
  return {
    filename: lib.filename,
    title: lib.title,
    ...(lib.author ? { author: lib.author } : {}),
    extension: lib.sourceFormat.toUpperCase(),
    size: 0,
    path: '',
    onDevice: false,
    libraryId: lib.id
  }
}

/**
 * Merges the device's books with the staging library into one display list.
 *
 * A device book is always shown (onDevice: true). If a library entry reconciles
 * to it — by targetRelpath matching the device relpath, or by a normalized
 * title|author identity — that entry's libraryId is attached and it does NOT
 * produce a second card. Library entries that reconcile to nothing become their
 * own "in library only" cards (onDevice: false). Pure and DOM-free for testing.
 */
export function mergeBooks(
  deviceBooks: KindleBook[],
  libraryBooks: LibraryBook[],
  documentsBase: string
): DisplayBook[] {
  const usedLibraryIds = new Set<string>()

  const deviceCards: DisplayBook[] = deviceBooks.map((device) => {
    const relpath = toBookRelpath(device.path, documentsBase)
    const idKey = identityKey(device.title, device.author)
    const match = libraryBooks.find(
      (lib) =>
        (lib.targetRelpath !== undefined && lib.targetRelpath === relpath) ||
        identityKey(lib.title, lib.author) === idKey
    )
    if (match) usedLibraryIds.add(match.id)
    return {
      ...device,
      onDevice: true,
      ...(match ? { libraryId: match.id } : {})
    }
  })

  const libraryOnlyCards: DisplayBook[] = libraryBooks
    .filter((lib) => !usedLibraryIds.has(lib.id))
    .map(libraryToDisplay)

  return [...deviceCards, ...libraryOnlyCards]
}
