import { toBase32 } from './encoding'

export interface SkeletonInput {
  title: string
  /** 1-based CSS flow numbers, linked in this order. */
  stylesheets: number[]
  htmlAttributes?: Readonly<Record<string, string>>
  bodyAttributes?: Readonly<Record<string, string>>
  /** The body's `aid`, which the chunk selector points at. */
  aid: string
}

export interface Skeleton {
  /** Everything up to and including the `<body …>` start tag: the chunk is inserted right after. */
  head: string
  tail: string
}

/**
 * Plain or `xml:`-prefixed XML names only. Other namespaced attributes
 * (`epub:type`, …) would need a namespace declaration the skeleton does not
 * carry, and the writer owns `xmlns` and `aid` itself.
 */
const SAFE_ATTRIBUTE = /^(xml:)?[A-Za-z_][-A-Za-z0-9_.]*$/
const RESERVED_ATTRIBUTES = new Set(['xmlns', 'aid'])

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function attributes(attrs: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(attrs ?? {})
    .filter(([name]) => SAFE_ATTRIBUTE.test(name) && !RESERVED_ATTRIBUTES.has(name))
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('')
}

export function flowUri(flow: number): string {
  return `kindle:flow:${toBase32(flow, 4)}?mime=text/css`
}

/** A complete XHTML document with an empty, aid-tagged body, in calibre's layout. */
export function buildSkeleton(input: SkeletonInput): Skeleton {
  const links = input.stylesheets
    .map((flow) => `<link rel="stylesheet" type="text/css" href="${flowUri(flow)}"/>\n`)
    .join('')
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml"${attributes(input.htmlAttributes)}>\n` +
    '<head>\n' +
    `<title>${escapeXml(input.title)}</title>\n` +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\n' +
    links +
    '</head>\n' +
    `<body${attributes(input.bodyAttributes)} aid="${input.aid}">`
  return { head, tail: '</body>\n</html>' }
}
