/**
 * The format EPUBs are converted to before upload.
 *
 * The native converter writes AZW3 (KF8) only — what calibre itself defaults
 * to, and what every Kindle reads from the Kindle Keyboard (with its 2012 KF8
 * firmware update) onwards; Kindle 1, 2 and DX do not. The old MOBI
 * option is gone; a `settings.json` left behind by an earlier version that
 * still says "mobi" is simply no longer read.
 */
export type KindleFormat = 'azw3'

export const KINDLE_FORMAT: KindleFormat = 'azw3'
