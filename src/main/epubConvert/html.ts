import { DomUtils } from 'htmlparser2'
import { hasChildren, isCDATA, isTag, isText, type ChildNode, type Document, type Element } from 'domhandler'
import { findAllByName, findFirstByName, localName, normalizedText, parseHtml } from './dom'
import { EpubInvalidError } from './errors'
import { isExternalHref, resolveHref, type ResolvedHref } from './paths'
import { serialize, type XElement, type XNode } from './serialize'

/** What the book-level converter provides to each document it transforms. */
export interface DocumentContext {
  /** Archive path of the document (hrefs resolve against it). */
  path: string
  imageUri(archivePath: string): string | undefined
  /** A `kindle:pos` link (or placeholder) for a target inside the book, else undefined. */
  linkUri(target: ResolvedHref): string | undefined
  stylesheetFlow(archivePath: string): number | undefined
  inlineStyleFlow(css: string): number
  styleAttribute(css: string): string
}

export interface TransformedDocument {
  title?: string
  htmlAttributes: Record<string, string>
  bodyAttributes: Record<string, string>
  body: string
  anchors: Map<string, number>
  stylesheets: number[]
}

type Attribute = readonly [string, string]

/** Elements with nothing a Kindle can render (scripts, embeds, media) or that live in <head>. */
const DROPPED = new Set([
  'script', 'noscript', 'template', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas',
  'style', 'link', 'meta', 'title', 'base', 'head'
])
const HTML_ATTRIBUTES = new Set(['lang', 'xml:lang', 'dir'])
const PLAIN_ATTRIBUTE = /^[A-Za-z_][-A-Za-z0-9_.]*$/
const ALLOWED_PREFIX = /^(xml|xmlns|xlink):[A-Za-z_][-A-Za-z0-9_.]*$/
const IMG_SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'srcset', 'sizes'])
/** htmlparser2 accepts `"`, `<`, `=` in tag names; writing them out would corrupt the XHTML. */
const VALID_ELEMENT_NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*$/
/**
 * Real books nest a few dozen levels at most. The cap keeps the recursive
 * transform/serialize (and DomUtils helpers) far from the stack limit.
 */
const MAX_NESTING_DEPTH = 256

/** Checked iteratively, before anything recursive walks the tree. */
function assertReasonableDepth(doc: Document): void {
  const stack: Array<[ChildNode[], number]> = [[doc.children, 1]]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [nodes, depth] = next
    if (depth > MAX_NESTING_DEPTH) throw new EpubInvalidError('A content document is nested too deeply')
    for (const node of nodes) {
      if (hasChildren(node)) stack.push([node.children, depth + 1])
    }
  }
}

function isAllowedAttribute(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('on') || lower === 'aid') return false
  return name.includes(':') ? ALLOWED_PREFIX.test(name) : PLAIN_ATTRIBUTE.test(name)
}

/** Drops event handlers, `aid` and undeclared namespaces; sanitizes inline styles. */
function cleanAttributes(
  attribs: Readonly<Record<string, string>>,
  ctx: DocumentContext,
  omit: ReadonlySet<string> = new Set()
): Attribute[] {
  return Object.entries(attribs).flatMap(([name, value]): Attribute[] => {
    if (omit.has(name.toLowerCase()) || !isAllowedAttribute(name)) return []
    if (name.toLowerCase() !== 'style') return [[name, value]]
    const style = ctx.styleAttribute(value)
    return style ? [[name, style]] : []
  })
}

function element(name: string, attributes: Attribute[], children: XNode[] = []): XElement {
  return { kind: 'element', name, attributes, children }
}

function imageFor(href: string | undefined, ctx: DocumentContext): string | undefined {
  const target = href ? resolveHref(ctx.path, href) : undefined
  return target ? ctx.imageUri(target.path) : undefined
}

/** An image the book cannot carry is removed rather than left as a broken reference. */
function convertImg(el: Element, ctx: DocumentContext): XNode[] {
  const uri = imageFor(el.attribs.src, ctx)
  if (!uri) return []
  return [element(el.name, [['src', uri], ...cleanAttributes(el.attribs, ctx, IMG_SOURCE_ATTRIBUTES)])]
}

/** The common cover-page pattern — an <svg> wrapping one <image> — becomes a plain <img>. */
function svgCover(el: Element, ctx: DocumentContext): XNode[] | undefined {
  const elements = el.children.filter(isTag)
  if (elements.length !== 1 || localName(elements[0].name) !== 'image') return undefined
  const uri = imageFor(elements[0].attribs['xlink:href'] ?? elements[0].attribs.href, ctx)
  return uri ? [element('img', [['src', uri], ['alt', '']])] : []
}

/** Internal links become `kindle:pos`, external ones stay, anything else loses its href. */
function rewriteHref(attrs: Attribute[], ctx: DocumentContext): Attribute[] {
  return attrs.flatMap(([name, value]): Attribute[] => {
    if (name !== 'href') return [[name, value]]
    if (/^\s*javascript:/i.test(value)) return []
    if (isExternalHref(value)) return [[name, value]]
    const target = resolveHref(ctx.path, value)
    const uri = target ? ctx.linkUri(target) : undefined
    return uri ? [[name, uri]] : []
  })
}

/** An <image> inside SVG: its href is rewritten to the embedded resource, or it goes. */
function foreignImageAttributes(el: Element, attrs: Attribute[], ctx: DocumentContext): Attribute[] | undefined {
  const uri = imageFor(el.attribs['xlink:href'] ?? el.attribs.href, ctx)
  return uri ? [...attrs.filter(([n]) => n !== 'href' && n !== 'xlink:href'), ['xlink:href', uri]] : undefined
}

function convertElement(el: Element, ctx: DocumentContext, foreign: boolean): XNode[] {
  const lower = el.name.toLowerCase()
  if (DROPPED.has(lower)) return []
  if (!VALID_ELEMENT_NAME.test(el.name)) return el.children.flatMap((c) => convertNode(c, ctx, foreign))
  if (lower === 'img') return convertImg(el, ctx)
  const cover = lower === 'svg' && !foreign ? svgCover(el, ctx) : undefined
  if (cover) return cover

  const inForeign = foreign || lower === 'svg' || lower === 'math'
  const isForeignImage = inForeign && localName(lower) === 'image'
  const cleaned = cleanAttributes(el.attribs, ctx)
  // Inside SVG only <image> keeps a reference (rewritten below); SVG links have
  // no Kindle target and would otherwise pass arbitrary URLs through.
  const linked = inForeign
    ? cleaned.filter(([n]) => isForeignImage || (n !== 'href' && n !== 'xlink:href'))
    : lower === 'a' || lower === 'area'
      ? rewriteHref(cleaned, ctx)
      : cleaned
  const attrs = isForeignImage ? foreignImageAttributes(el, linked, ctx) : linked
  if (!attrs) return []
  return [element(el.name, attrs, el.children.flatMap((c) => convertNode(c, ctx, inForeign)))]
}

function convertNode(node: ChildNode, ctx: DocumentContext, foreign: boolean): XNode[] {
  if (isText(node)) return [{ kind: 'text', text: node.data }]
  if (isCDATA(node)) return node.children.flatMap((c) => convertNode(c, ctx, foreign))
  if (isTag(node)) return convertElement(node, ctx, foreign)
  return [] // comments, processing instructions, doctypes
}

/** Linked and inline stylesheets, in document order, as flow numbers. */
function collectStylesheets(head: Element | undefined, body: Element | undefined, ctx: DocumentContext): number[] {
  const fromHead = (head?.children.filter(isTag) ?? []).flatMap((el): number[] => {
    const name = localName(el.name)
    if (name === 'style') return [ctx.inlineStyleFlow(DomUtils.textContent(el))]
    const rel = (el.attribs.rel ?? '').toLowerCase().split(/\s+/)
    if (name !== 'link' || !rel.includes('stylesheet') || rel.includes('alternate')) return []
    const target = el.attribs.href ? resolveHref(ctx.path, el.attribs.href) : undefined
    const flow = target ? ctx.stylesheetFlow(target.path) : undefined
    return flow === undefined ? [] : [flow]
  })
  const fromBody = body ? findAllByName(body, 'style').map((el) => ctx.inlineStyleFlow(DomUtils.textContent(el))) : []
  return [...new Set([...fromHead, ...fromBody])]
}

/** The document's <title>, else its first heading. */
function documentTitle(head: Element | undefined, body: Element | undefined): string | undefined {
  const title = head ? findFirstByName(head, 'title') : undefined
  const fromTitle = title ? normalizedText(title) : ''
  if (fromTitle) return fromTitle
  const heading = body ? DomUtils.findOne((el) => /^h[1-6]$/.test(localName(el.name)), body.children) : null
  return (heading ? normalizedText(heading) : '') || undefined
}

/** Turns one content document into a KF8 part body plus what the book needs to know about it. */
export function transformDocument(source: string, ctx: DocumentContext): TransformedDocument {
  const doc = parseHtml(source)
  assertReasonableDepth(doc)
  const html = findFirstByName(doc, 'html')
  const head = html ? findFirstByName(html, 'head') : undefined
  const body = findFirstByName(doc, 'body')
  const content = body?.children ?? html?.children ?? doc.children

  const serialized = serialize(content.flatMap((c) => convertNode(c, ctx, false)))
  const bodyId = body?.attribs.id
  const anchors =
    bodyId && !serialized.anchors.has(bodyId) ? new Map([...serialized.anchors, [bodyId, 0]]) : serialized.anchors

  return {
    title: documentTitle(head, body),
    htmlAttributes: Object.fromEntries(Object.entries(html?.attribs ?? {}).filter(([n]) => HTML_ATTRIBUTES.has(n))),
    bodyAttributes: Object.fromEntries(
      cleanAttributes(body?.attribs ?? {}, ctx, new Set(['id'])).filter(([name]) => !name.includes(':'))
    ),
    body: serialized.html,
    anchors,
    stylesheets: collectStylesheets(head, body, ctx)
  }
}
