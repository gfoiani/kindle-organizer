import path from 'path'

export interface ResolvedHref {
  /** Archive path, posix-separated, relative to the archive root. */
  path: string
  fragment?: string
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

export function isExternalHref(href: string): boolean {
  return SCHEME.test(href.trim())
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // Not valid percent-encoding: the raw text is the most faithful reading.
    return value
  }
}

/**
 * Resolves an href found in `basePath` to an archive path. Returns undefined
 * for external URLs and for anything that would escape the archive root —
 * a hostile `../../` never reaches a lookup.
 */
export function resolveHref(basePath: string, href: string): ResolvedHref | undefined {
  const trimmed = href.trim()
  if (!trimmed || isExternalHref(trimmed)) return undefined

  const hash = trimmed.indexOf('#')
  const rawPath = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).split('?')[0]
  const fragment = hash >= 0 ? safeDecode(trimmed.slice(hash + 1)) : ''
  const withFragment = (p: string): ResolvedHref => (fragment ? { path: p, fragment } : { path: p })

  if (!rawPath) return withFragment(basePath)
  if (rawPath.startsWith('/')) return undefined

  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(basePath), safeDecode(rawPath)))
  if (joined === '..' || joined.startsWith('../')) return undefined
  return withFragment(joined)
}
