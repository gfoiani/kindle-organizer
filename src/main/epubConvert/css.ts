import { resolveHref } from './paths'

/** Maps an archive path to its `kindle:embed` URI, or undefined when not embeddable. */
export type ImageResolver = (archivePath: string) => string | undefined

const COMMENT = /\/\*[\s\S]*?\*\//g
// Embedded fonts are not carried over (the device's own fonts are used), so
// their declarations would only point at resources that are not there.
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi
// Imported sheets are not followed; a dangling @import is dropped.
const IMPORT = /@import\s+[^;]+;?/gi
const URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi

/**
 * Makes a stylesheet (or a style attribute) safe for KF8: comments, font faces
 * and imports go; `url()` references to images in the book become
 * `kindle:embed` URIs. Other URLs are left as they are.
 */
export function sanitizeCss(css: string, basePath: string, resolveImage: ImageResolver): string {
  return css
    .replace(COMMENT, '')
    .replace(FONT_FACE, '')
    .replace(IMPORT, '')
    .replace(URL, (match, _quote: string, href: string) => {
      const target = resolveHref(basePath, href)
      const uri = target ? resolveImage(target.path) : undefined
      return uri ? `url(${uri})` : match
    })
    .trim()
}
