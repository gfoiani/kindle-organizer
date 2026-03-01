import { useState, useEffect, useRef } from 'react'
import type { Collection } from '../../../preload/api'

interface CollectionPickerProps {
  bookRelpath: string
  collections: Collection[]
  onAdd: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemove: (collectionId: string, bookRelpath: string) => Promise<void>
  onClose: () => void
}

export function CollectionPicker({
  bookRelpath,
  collections,
  onAdd,
  onRemove,
  onClose
}: CollectionPickerProps) {
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.kindleAPI
      .getBookCollections(bookRelpath)
      .then((ids) => setMemberIds(new Set(ids)))
      .catch(() => setMemberIds(new Set()))
      .finally(() => setLoading(false))
  }, [bookRelpath])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  async function toggle(collectionId: string) {
    if (pending) return
    setPending(collectionId)
    try {
      if (memberIds.has(collectionId)) {
        await onRemove(collectionId, bookRelpath)
        setMemberIds((prev) => {
          const next = new Set(prev)
          next.delete(collectionId)
          return next
        })
      } else {
        await onAdd(collectionId, bookRelpath)
        setMemberIds((prev) => new Set([...prev, collectionId]))
      }
    } catch (err) {
      console.error('Failed to update collection membership:', err)
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      ref={ref}
      className="absolute z-50 right-0 top-full mt-1 w-52 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1"
    >
      <p className="px-3 py-1.5 text-gray-400 text-xs font-semibold uppercase tracking-wider border-b border-gray-700 mb-1">
        Aggiungi a collezione
      </p>

      {loading && (
        <div className="px-3 py-2 text-gray-500 text-xs">Caricamento...</div>
      )}

      {!loading && collections.length === 0 && (
        <div className="px-3 py-2 text-gray-500 text-xs">Nessuna collezione disponibile</div>
      )}

      {!loading &&
        collections.map((collection) => {
          const isMember = memberIds.has(collection.id)
          const isProcessing = pending === collection.id
          return (
            <button
              key={collection.id}
              onClick={() => toggle(collection.id)}
              disabled={isProcessing}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-50"
            >
              <span
                className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${
                  isMember
                    ? 'bg-indigo-600 border-indigo-600'
                    : 'border-gray-500'
                }`}
              >
                {isMember && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
              <span className="truncate">{collection.name}</span>
              {collection.source === 'calibre' && (
                <span className="ml-auto text-gray-600 text-xs shrink-0">calibre</span>
              )}
            </button>
          )
        })}
    </div>
  )
}
