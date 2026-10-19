import { DomUtils, parseDocument } from 'htmlparser2'
import type { Document, Element } from 'domhandler'

/**
 * Content documents are parsed as HTML, not XML: HTML mode decodes the named
 * entities (`&nbsp;`, `&eacute;`) XHTML files use without declaring a DTD, and
 * recovers from the malformed markup real-world EPUBs contain; `<a id="x"/>`
 * still closes.
 *
 * Tag names are lowercased while parsing: htmlparser2 applies HTML's
 * implied-close rules (an unclosed `<P>` or `<LI>`) to lowercase names only, so
 * uppercase legacy markup would otherwise nest one level per tag. SVG's
 * camelCase element names are put back afterwards (`restoreSvgElementNames`),
 * and attribute case is kept (`viewBox`).
 */
export function parseHtml(source: string): Document {
  const doc = parseDocument(source, {
    xmlMode: false,
    decodeEntities: true,
    recognizeSelfClosing: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: false
  })
  restoreSvgElementNames(doc)
  return doc
}

/** The camelCase SVG elements — the table an HTML5 parser uses to "adjust SVG tag names". */
const SVG_ELEMENT_NAMES: ReadonlyMap<string, string> = new Map(
  [
    'altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion', 'animateTransform',
    'clipPath', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
    'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence', 'foreignObject', 'glyphRef', 'linearGradient', 'radialGradient', 'textPath'
  ].map((name) => [name.toLowerCase(), name])
)

/**
 * Renames the lowercased camelCase elements found inside `<svg>`. The document
 * was just built by the parser and is not shared yet, so it is fixed in place;
 * the walk is iterative because the tree's depth is not checked until later.
 */
function restoreSvgElementNames(doc: Document): void {
  const pending: Array<{ children: Document['children']; inSvg: boolean }> = [{ children: doc.children, inSvg: false }]
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const child of next.children) {
      if (child.type !== 'tag' && child.type !== 'script' && child.type !== 'style') continue
      const el = child as Element
      if (next.inSvg) el.name = SVG_ELEMENT_NAMES.get(el.name) ?? el.name
      pending.push({ children: el.children, inSvg: next.inSvg || el.name === 'svg' })
    }
  }
}

/** Package-level XML (NCX, encryption.xml): strict XML entities only. */
export function parseXml(source: string): Document {
  return parseDocument(source, { xmlMode: true, decodeEntities: true })
}

/** `enc:EncryptionMethod` → `encryptionmethod`. */
export function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1).toLowerCase()
}

export function findAllByName(root: Document | Element, name: string): Element[] {
  return DomUtils.findAll((el) => localName(el.name) === name, root.children)
}

export function findFirstByName(root: Document | Element, name: string): Element | undefined {
  return DomUtils.findOne((el) => localName(el.name) === name, root.children) ?? undefined
}

/** Text content with runs of whitespace collapsed, as a reader displays it. */
export function normalizedText(el: Element): string {
  return DomUtils.textContent(el).replace(/\s+/g, ' ').trim()
}

/** Decodes a content document honouring a UTF-16 BOM or the XML declaration's encoding (UTF-8 otherwise). */
export function decodeDocument(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data)
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data)
  const head = data.subarray(0, 200).toString('latin1')
  const declared = head.match(/^(?:\xEF\xBB\xBF)?<\?xml[^>]*encoding=["']([A-Za-z0-9._-]+)["']/)?.[1]
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(data)
  } catch {
    // Unknown encoding label: UTF-8 is what virtually every EPUB actually uses.
    return new TextDecoder('utf-8').decode(data)
  }
}
