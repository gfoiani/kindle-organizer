import { kindleEmbedUri, kindlePosUri } from '../kf8'
import { sanitizeCss } from './css'
import { sniffImageMime, type KindleImageMime } from './images'
import type { ResolvedHref } from './paths'

export interface LoadedImage {
  data: Buffer
  mime: KindleImageMime
}

/**
 * Book-wide bookkeeping while documents are transformed one by one: which
 * images and stylesheets end up in the book (in first-use order) and which
 * internal links still need their target position.
 *
 * Links are emitted as fixed-width placeholders exactly as long as a real
 * `kindle:pos` URI, so swapping them in afterwards moves no byte — the anchor
 * offsets recorded while serializing stay valid.
 */
export interface BookRegistry {
  images(): Buffer[]
  stylesheets(): string[]
  imageUri(archivePath: string): string | undefined
  imageIndex(archivePath: string): number | undefined
  /** Adds raw image bytes (the app-supplied cover); reuses an identical image already in the book. */
  addImage(data: Buffer): number | undefined
  stylesheetFlow(archivePath: string): number | undefined
  inlineStyleFlow(css: string, basePath: string): number
  styleAttribute(css: string, basePath: string): string
  linkUri(target: ResolvedHref): string | undefined
  resolveLinks(body: string, anchorsByPart: ReadonlyArray<ReadonlyMap<string, number>>): string
}

const PLACEHOLDER_PREFIX = 'kindle:pos:fid:zzzz:off:'
const PLACEHOLDER = /kindle:pos:fid:zzzz:off:([a-z]{10})/g
const PLACEHOLDER_DIGITS = 10

function encodePlaceholder(n: number): string {
  let code = ''
  let rest = n
  do {
    code = String.fromCharCode(97 + (rest % 26)) + code
    rest = Math.floor(rest / 26)
  } while (rest > 0)
  return PLACEHOLDER_PREFIX + code.padStart(PLACEHOLDER_DIGITS, 'a')
}

function decodePlaceholder(code: string): number {
  return [...code].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 97), 0)
}

export function createRegistry(
  loadedImages: ReadonlyMap<string, LoadedImage>,
  rawStylesheets: ReadonlyMap<string, string>,
  partIndexByPath: ReadonlyMap<string, number>
): BookRegistry {
  const images: LoadedImage[] = []
  const imageIndexByPath = new Map<string, number>()
  const flows: string[] = []
  const flowByKey = new Map<string, number>()
  const links: Array<{ part: number; fragment?: string }> = []

  const imageIndex = (archivePath: string): number | undefined => {
    const known = imageIndexByPath.get(archivePath)
    if (known !== undefined) return known
    const loaded = loadedImages.get(archivePath)
    if (!loaded) return undefined
    images.push(loaded)
    imageIndexByPath.set(archivePath, images.length - 1)
    return images.length - 1
  }

  const resolveImage = (archivePath: string): string | undefined => {
    const index = imageIndex(archivePath)
    return index === undefined ? undefined : kindleEmbedUri(index, images[index].mime)
  }

  const flowFor = (key: string, css: () => string): number => {
    const known = flowByKey.get(key)
    if (known !== undefined) return known
    flows.push(css())
    flowByKey.set(key, flows.length)
    return flows.length
  }

  return {
    images: () => images.map((i) => i.data),
    stylesheets: () => [...flows],
    imageUri: resolveImage,
    imageIndex,
    addImage(data) {
      const mime = sniffImageMime(data)
      if (!mime) return undefined
      const existing = images.findIndex((i) => i.data.equals(data))
      if (existing >= 0) return existing
      images.push({ data, mime })
      return images.length - 1
    },
    stylesheetFlow(archivePath) {
      const raw = rawStylesheets.get(archivePath)
      if (raw === undefined) return undefined
      return flowFor(`file:${archivePath}`, () => sanitizeCss(raw, archivePath, resolveImage))
    },
    inlineStyleFlow(css, basePath) {
      const sanitized = sanitizeCss(css, basePath, resolveImage)
      return flowFor(`inline:${sanitized}`, () => sanitized)
    },
    styleAttribute: (css, basePath) => sanitizeCss(css, basePath, resolveImage),
    linkUri(target) {
      const part = partIndexByPath.get(target.path)
      if (part === undefined) return undefined
      links.push(target.fragment ? { part, fragment: target.fragment } : { part })
      return encodePlaceholder(links.length - 1)
    },
    resolveLinks(body, anchorsByPart) {
      return body.replace(PLACEHOLDER, (_match, code: string) => {
        const link = links[decodePlaceholder(code)]
        const offset = link.fragment ? (anchorsByPart[link.part]?.get(link.fragment) ?? 0) : 0
        return kindlePosUri(link.part, offset)
      })
    }
  }
}
