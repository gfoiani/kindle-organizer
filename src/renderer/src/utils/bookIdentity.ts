/**
 * Normalizes a title|author pair into a stable identity key used for reconciliation
 * (mergeBooks.ts) and placeholder tint selection (coverPlaceholder.ts).
 *
 * Back-compat–sensitive: do NOT change this derivation (add a field, change the
 * separator, normalize differently, etc.) for a cosmetic reason such as spreading
 * placeholder tints more evenly. This key is what decides which on-device book a
 * staging-library entry reconciles with in mergeBooks.ts — widening it (e.g.
 * appending `|${isbn ?? ''}`) would silently change which books reconcile with
 * which in the field. The risk is asymmetric: the existing mergeBooks tests catch
 * the key being *weakened* (two genuinely different books colliding on one card)
 * but cannot catch it being *widened*, since every test that checks two
 * known-equal books still match would keep passing under a wider key too.
 *
 * macOS hands back decomposed (NFD) names from the Kindle volume — "è" as `e` +
 * U+0300 — while EPUB metadata and names written by the app are composed (NFC).
 * The two look identical and compare unequal, which silently broke reconciliation:
 * a book was uploaded and recorded, then still showed up as a second "library only"
 * card, and would get a different placeholder tint depending which filesystem it
 * was read from. NFC normalization ensures the same book keeps the same identity
 * (and thus the same tint) whether macOS or the app provided its name.
 *
 * Each part (title, author) is normalized separately so a trailing space in the
 * title cannot leak across the `|` separator.
 */
export function bookIdentityKey(title: string, author?: string): string {
  return `${title.normalize('NFC').trim().toLowerCase()}|${(author ?? '').normalize('NFC').trim().toLowerCase()}`
}
