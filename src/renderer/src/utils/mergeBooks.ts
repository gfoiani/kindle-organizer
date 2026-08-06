import type { KindleBook, LibraryBook } from '../../../preload/api'
import { bookIdentityKey } from './bookIdentity'
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

/**
 * Canonical Unicode form for any string that crossed the device filesystem.
 *
 * macOS hands back decomposed (NFD) names from the Kindle volume — "è" as
 * `e` + U+0300 — while EPUB metadata and the names the app itself writes are
 * composed (NFC). The two look identical and compare unequal, which silently
 * broke reconciliation for every accented title: the book was uploaded and
 * recorded, then still showed up as a second "library only" card.
 *
 * Comparison keys only. A real path must stay exactly as the filesystem gave
 * it, or opening the file can fail.
 */
function canonical(value: string): string {
  return value.normalize('NFC')
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
    const relpath = canonical(toBookRelpath(device.path, documentsBase))
    const idKey = bookIdentityKey(device.title, device.author)
    // Reconcile to at most one still-unused library entry (skipping ids already
    // claimed by an earlier device card keeps two identical device books from
    // sharing a libraryId — and thus a React key). Match on the recorded upload
    // target, or — only for a book that was actually sent (`uploadedAt` set) — on
    // identity, so a never-uploaded staged book that merely shares a title|author
    // with an unrelated device book stays its own card and keeps its send/remove UI.
    const match = libraryBooks.find(
      (lib) =>
        !usedLibraryIds.has(lib.id) &&
        ((lib.targetRelpath !== undefined && canonical(lib.targetRelpath) === relpath) ||
          (lib.uploadedAt !== undefined && bookIdentityKey(lib.title, lib.author) === idKey))
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
