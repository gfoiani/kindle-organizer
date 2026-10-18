import { DomUtils, parseDocument } from 'htmlparser2'
import type { Document, Element } from 'domhandler'

/**
 * Content documents are parsed as HTML, not XML: HTML mode decodes the named
 * entities (`&nbsp;`, `&eacute;`) XHTML files use without declaring a DTD, and
 * recovers from the malformed markup real-world EPUBs contain. Case is kept so
 * SVG (`viewBox`, `foreignObject`) survives, and `<a id="x"/>` still closes.
 */
export function parseHtml(source: string): Document {
  return parseDocument(source, {
    xmlMode: false,
    decodeEntities: true,
    recognizeSelfClosing: true,
    lowerCaseTags: false,
    lowerCaseAttributeNames: false
  })
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
