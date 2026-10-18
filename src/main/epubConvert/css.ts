import { resolveHref } from './paths'

/** Maps an archive path to its `kindle:embed` URI, or undefined when not embeddable. */
export type ImageResolver = (archivePath: string) => string | undefined

/*
 * Stylesheets come from untrusted EPUBs and are processed on the main process,
 * so everything here is a single forward scan built on indexOf — no regex with
 * overlapping quantifiers, which a crafted sheet can drive into minutes of
 * backtracking (an unterminated `@font-face{` repeated, or `url(` followed by
 * endless whitespace).
 */

/** Removes every `start … end` span; an unterminated one runs to the end of the sheet. */
function removeSpans(css: string, start: string, end: string, caseInsensitive = false): string {
  const haystack = caseInsensitive ? css.toLowerCase() : css
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const begin = haystack.indexOf(start, pos)
    if (begin < 0) break
    parts.push(css.slice(pos, begin))
    const stop = haystack.indexOf(end, begin + start.length)
    pos = stop < 0 ? css.length : stop + end.length
  }
  parts.push(css.slice(pos))
  return parts.join('')
}

/** `@font-face { … }`: the block, up to its closing brace. */
function removeFontFaces(css: string): string {
  const lower = css.toLowerCase()
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const begin = lower.indexOf('@font-face', pos)
    if (begin < 0) break
    parts.push(css.slice(pos, begin))
    const open = css.indexOf('{', begin)
    const close = open < 0 ? -1 : css.indexOf('}', open)
    pos = close < 0 ? css.length : close + 1
  }
  parts.push(css.slice(pos))
  return parts.join('')
}

function unquote(value: string): string {
  const first = value[0]
  return (first === '"' || first === "'") && value.length >= 2 && value[value.length - 1] === first
    ? value.slice(1, -1)
    : value
}

/** Rewrites `url(…)` references the resolver knows; leaves every other url() untouched. */
function rewriteUrls(css: string, basePath: string, resolveImage: ImageResolver): string {
  const lower = css.toLowerCase()
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const begin = lower.indexOf('url(', pos)
    if (begin < 0) break
    const close = css.indexOf(')', begin + 4)
    if (close < 0) break
    const href = unquote(css.slice(begin + 4, close).trim())
    const target = href ? resolveHref(basePath, href) : undefined
    const uri = target ? resolveImage(target.path) : undefined
    parts.push(css.slice(pos, begin), uri ? `url(${uri})` : css.slice(begin, close + 1))
    pos = close + 1
  }
  parts.push(css.slice(pos))
  return parts.join('')
}

/**
 * Makes a stylesheet (or a style attribute) safe for KF8: comments go;
 * embedded fonts go (the device's own fonts are used, so their declarations
 * would only point at resources that are not there); imports are not followed
 * and are dropped; `url()` references to images in the book become
 * `kindle:embed` URIs.
 */
export function sanitizeCss(css: string, basePath: string, resolveImage: ImageResolver): string {
  const withoutComments = removeSpans(css, '/*', '*/')
  const withoutFonts = removeFontFaces(withoutComments)
  const withoutImports = removeSpans(withoutFonts, '@import', ';', true)
  return rewriteUrls(withoutImports, basePath, resolveImage).trim()
}
