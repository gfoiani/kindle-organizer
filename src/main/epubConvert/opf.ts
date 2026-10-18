import { XMLParser } from 'fast-xml-parser'
import type { EpubArchive } from './archive'
import { EpubInvalidError } from './errors'
import { resolveHref } from './paths'

export interface ManifestItem {
  id: string
  /** Archive path of the resource. */
  path: string
  mediaType: string
  properties: string[]
}

export interface EpubPackage {
  title?: string
  authors: string[]
  language?: string
  manifest: ManifestItem[]
  /** Content documents in reading order (non-XHTML spine items are skipped). */
  spine: ManifestItem[]
  coverPath?: string
  navPath?: string
  ncxPath?: string
}

const CONTAINER_PATH = 'META-INF/container.xml'
const CONTENT_TYPES = new Set(['application/xhtml+xml', 'text/html'])
const NCX_TYPE = 'application/x-dtbncx+xml'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['rootfile', 'item', 'itemref', 'creator', 'title', 'language', 'meta'].includes(name)
})

type XmlNode = Record<string, unknown>

function asNode(value: unknown): XmlNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as XmlNode) : undefined
}

function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value.map(asNode).filter((n): n is XmlNode => n !== undefined) : []
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`]
  return typeof value === 'string' ? value : undefined
}

interface DcValue {
  text: string
  role?: string
}

/** dc:* values parse to a plain string, or to {#text, @_attrs} when they carry attributes. */
function dcValues(value: unknown): DcValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((v: unknown) => {
    const node = asNode(v)
    const raw = typeof v === 'string' ? v : node?.['#text']
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) return []
    const role = attr(node, 'role')
    return [role ? { text, role } : { text }]
  })
}

async function readOpfPath(archive: EpubArchive): Promise<string> {
  if (!archive.has(CONTAINER_PATH)) throw new EpubInvalidError('The EPUB has no META-INF/container.xml')
  const container = parser.parse((await archive.read(CONTAINER_PATH)).toString('utf-8'))
  const rootfiles = asNode(asNode(container?.container)?.rootfiles)
  const fullPath = attr(nodes(rootfiles?.rootfile)[0], 'full-path')
  if (!fullPath || !archive.has(fullPath)) throw new EpubInvalidError('The EPUB has no package document')
  return fullPath
}

function readManifest(manifestNode: XmlNode | undefined, opfPath: string): ManifestItem[] {
  return nodes(manifestNode?.item).flatMap((item) => {
    const id = attr(item, 'id')
    const href = attr(item, 'href')
    const target = href ? resolveHref(opfPath, href) : undefined
    if (!id || !target) return []
    return [
      {
        id,
        path: target.path,
        mediaType: (attr(item, 'media-type') ?? '').toLowerCase(),
        properties: (attr(item, 'properties') ?? '').split(/\s+/).filter(Boolean)
      }
    ]
  })
}

function readAuthors(metadata: XmlNode | undefined): string[] {
  const creators = dcValues(metadata?.creator)
  const authors = creators.filter((c) => (c.role ?? 'aut') === 'aut')
  return (authors.length > 0 ? authors : creators).map((c) => c.text)
}

/** EPUB3 cover-image property, then the EPUB2 <meta name="cover">, then an id that says "cover". */
function findCover(manifest: ManifestItem[], metadata: XmlNode | undefined): string | undefined {
  const byProperty = manifest.find((i) => i.properties.includes('cover-image'))
  if (byProperty) return byProperty.path
  const coverId = attr(nodes(metadata?.meta).find((m) => attr(m, 'name') === 'cover'), 'content')
  const byMeta = manifest.find((i) => i.id === coverId)
  if (byMeta) return byMeta.path
  return manifest.find((i) => i.mediaType.startsWith('image/') && i.id.toLowerCase().includes('cover'))?.path
}

/** Reads container.xml and the OPF: metadata, manifest, spine, cover and navigation documents. */
export async function readPackage(archive: EpubArchive): Promise<EpubPackage> {
  const opfPath = await readOpfPath(archive)
  const opf = parser.parse((await archive.read(opfPath)).toString('utf-8'))
  const pkg = asNode(opf?.package)
  if (!pkg) throw new EpubInvalidError('The EPUB package document is not readable')

  const metadata = asNode(pkg.metadata)
  const spineNode = asNode(pkg.spine)
  const manifest = readManifest(asNode(pkg.manifest), opfPath)
  const byId = new Map(manifest.map((i) => [i.id, i]))

  const spine = nodes(spineNode?.itemref)
    .map((ref) => byId.get(attr(ref, 'idref') ?? ''))
    .filter((i): i is ManifestItem => i !== undefined && CONTENT_TYPES.has(i.mediaType))

  const ncxId = attr(spineNode, 'toc')
  const ncx = (ncxId ? byId.get(ncxId) : undefined) ?? manifest.find((i) => i.mediaType === NCX_TYPE)

  return {
    title: dcValues(metadata?.title)[0]?.text,
    authors: readAuthors(metadata),
    language: dcValues(metadata?.language)[0]?.text,
    manifest,
    spine,
    coverPath: findCover(manifest, metadata),
    navPath: manifest.find((i) => i.properties.includes('nav'))?.path,
    ncxPath: ncx?.path
  }
}
