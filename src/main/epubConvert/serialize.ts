/**
 * A minimal, immutable XHTML tree and its serializer.
 *
 * The serializer exists (instead of dom-serializer) because KF8 needs output
 * that is BOTH valid XML and safe for an HTML parser: void elements
 * self-closed (`<br/>`), every other element explicitly closed (`<div></div>`,
 * never `<div/>`), no named entities beyond the XML five. It also records the
 * byte offset of every `id`/`name` while writing — the positions `kindle:pos`
 * links and the NCX point at.
 */

export interface XText {
  kind: 'text'
  text: string
}

export interface XElement {
  kind: 'element'
  name: string
  attributes: ReadonlyArray<readonly [string, string]>
  children: readonly XNode[]
}

export type XNode = XText | XElement

export interface Serialized {
  html: string
  /** Anchor (id or name) → byte offset of its element's `<`. First occurrence wins. */
  anchors: Map<string, number>
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])
const FOREIGN_ROOTS = new Set(['svg', 'math'])
const ANCHOR_ATTRIBUTES = new Set(['id', 'name'])

export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

export function serialize(nodes: readonly XNode[]): Serialized {
  const pieces: string[] = []
  const anchors = new Map<string, number>()
  let bytes = 0

  const write = (piece: string): void => {
    pieces.push(piece)
    bytes += Buffer.byteLength(piece, 'utf-8')
  }

  const emit = (node: XNode, foreign: boolean): void => {
    if (node.kind === 'text') {
      write(escapeText(node.text))
      return
    }
    for (const [name, value] of node.attributes) {
      if (ANCHOR_ATTRIBUTES.has(name) && value && !anchors.has(value)) anchors.set(value, bytes)
    }
    const lower = node.name.toLowerCase()
    const inForeign = foreign || FOREIGN_ROOTS.has(lower)
    const attrs = node.attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')

    if (VOID_ELEMENTS.has(lower) || (inForeign && node.children.length === 0)) {
      write(`<${node.name}${attrs}/>`)
      return
    }
    write(`<${node.name}${attrs}>`)
    for (const child of node.children) emit(child, inForeign)
    write(`</${node.name}>`)
  }

  for (const node of nodes) emit(node, false)
  return { html: pieces.join(''), anchors }
}
