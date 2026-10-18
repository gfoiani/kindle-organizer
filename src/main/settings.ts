/**
 * The format EPUBs are converted to before upload.
 *
 * The native converter writes AZW3 (KF8) only — what every Kindle since the
 * 2011 generation reads, and what calibre itself defaults to. The old MOBI
 * option is gone; a `settings.json` left behind by an earlier version that
 * still says "mobi" is simply no longer read.
 */
export type KindleFormat = 'azw3'

export const KINDLE_FORMAT: KindleFormat = 'azw3'

/** Narrows an untrusted value (an IPC argument) to a KindleFormat. */
export function isKindleFormat(value: unknown): value is KindleFormat {
  return value === KINDLE_FORMAT
}
