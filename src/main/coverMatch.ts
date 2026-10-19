/**
 * Deciding whether a provider's candidate really is this book's cover, and
 * whether downloaded bytes are an image at all.
 */

/** Relative weights when scoring a candidate by title vs author similarity. */
const TITLE_WEIGHT = 0.75
const AUTHOR_WEIGHT = 0.25
/** A buffer smaller than this can't be a real cover image (it's an error page). */
const MIN_IMAGE_BYTES = 500

// ─── Match verification ───────────────────────────────────────────────────────
// Providers return several candidates; we only accept one whose title (and
// author, when available) actually matches the book, instead of blindly taking
// the first result. This is the main defense against wrong covers.

export interface CoverCandidate {
  imageUrl: string
  title: string
  author?: string
}

// Combined match score must clear this, and the title alone must clear MIN_TITLE_SCORE.
const MATCH_THRESHOLD = 0.5
const MIN_TITLE_SCORE = 0.34

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
}

function tokenize(s: string): string[] {
  return normalize(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/** Fraction of the query's tokens that appear in the candidate text (0..1). */
function containment(query: string, candidate: string): number {
  const q = tokenize(query)
  if (q.length === 0) return 0
  const c = new Set(tokenize(candidate))
  let hit = 0
  for (const t of q) if (c.has(t)) hit++
  return hit / q.length
}

function matchScore(candidate: CoverCandidate, qTitle: string, qAuthor: string | undefined): number {
  const titleScore = containment(qTitle, candidate.title)
  if (titleScore < MIN_TITLE_SCORE) return 0
  if (qAuthor && candidate.author) {
    const authorScore = containment(qAuthor, candidate.author)
    return titleScore * TITLE_WEIGHT + authorScore * AUTHOR_WEIGHT
  }
  return titleScore
}

/** Picks the best-matching candidate above the acceptance threshold, or null. */
export function pickBestMatch(
  candidates: CoverCandidate[],
  qTitle: string,
  qAuthor: string | undefined
): CoverCandidate | null {
  let best: CoverCandidate | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = matchScore(candidate, qTitle, qAuthor)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null
}

/** Validates that a buffer is a real image (JPEG/PNG/GIF/WEBP), not an HTML error page. */
export function isValidImage(buf: Buffer): boolean {
  if (buf.length < MIN_IMAGE_BYTES) return false
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true
  }
  return false
}

