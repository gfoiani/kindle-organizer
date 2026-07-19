import { useEffect, useRef, useState } from 'react'
import type { CoverStatus } from '../../../preload/api'
import { buildCoverSrc } from '../utils/coverSrc'

interface CoverBook {
  title: string
  author?: string
  isbn?: string
}

interface CoverState {
  /** `cover-cache://` URL to render, or null when there is nothing to show yet. */
  coverSrc: string | null
  /** Resolved status: 'ready' | 'pending' | 'missing', or null before the first resolve. */
  status: CoverStatus | null
}

/**
 * Reactively resolves a single book's cover. Triggers a background `ensureCover`
 * and then follows the main-process `cover:updated` / `cover:missing` pushes for
 * the resolved key, so the src becomes correct even when the download finishes
 * AFTER the consumer mounted — e.g. the detail sidebar opened while the cover was
 * still pending (previously it captured a null snapshot and never updated).
 *
 * `coverEpoch` (bumped on a cache-clear) is folded into the effect deps so a
 * clear re-ensures, and into the cache-buster so the fresh bytes aren't masked
 * by Chromium's immutable HTTP cache.
 */
export function useCover(book: CoverBook, coverEpoch = 0): CoverState {
  const [coverKey, setCoverKey] = useState<string | null>(null)
  const [status, setStatus] = useState<CoverStatus | null>(null)
  const [version, setVersion] = useState(0)
  const [hasVersion, setHasVersion] = useState(false)
  const [pushedMissing, setPushedMissing] = useState(false)

  // Mirrors coverKey for the (stable) push listeners without re-subscribing.
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    keyRef.current = null
    setCoverKey(null)
    setStatus(null)
    setVersion(0)
    setHasVersion(false)
    setPushedMissing(false)

    window.kindleAPI
      .ensureCover(book.title, book.author, book.isbn)
      .then((r) => {
        if (cancelled) return
        keyRef.current = r.key
        setCoverKey(r.key)
        setStatus(r.status)
      })
      .catch((err) => {
        if (!cancelled) console.error('ensureCover failed:', err)
      })

    return () => {
      cancelled = true
      window.kindleAPI.cancelCover(book.title, book.author, book.isbn)
    }
  }, [book.title, book.author, book.isbn, coverEpoch])

  useEffect(() => {
    const offUpdated = window.kindleAPI.onCoverUpdated((key) => {
      if (key !== keyRef.current) return
      setVersion((v) => v + 1)
      setHasVersion(true)
      setPushedMissing(false)
    })
    const offMissing = window.kindleAPI.onCoverMissing((key) => {
      if (key !== keyRef.current) return
      setPushedMissing(true)
    })
    return () => {
      offUpdated()
      offMissing()
    }
  }, [])

  const effectiveStatus: CoverStatus | null = pushedMissing ? 'missing' : status
  const showImage = coverKey !== null && !pushedMissing && (status === 'ready' || hasVersion)
  const coverSrc = showImage && coverKey ? buildCoverSrc(coverKey, version, coverEpoch) : null

  return { coverSrc, status: effectiveStatus }
}
