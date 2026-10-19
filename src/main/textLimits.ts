/**
 * Longest title or author name kept from a book's own metadata. Real ones are
 * a few dozen characters; an EPUB is untrusted, and these strings end up in
 * the library database, the UI and the converted file's headers.
 */
export const MAX_METADATA_TEXT = 512

/** `text` cut to `max` UTF-16 code units, never inside a surrogate pair. */
export function capLength(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
