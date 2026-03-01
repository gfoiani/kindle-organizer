import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from './components/Sidebar'
import { BooksGrid } from './components/BooksGrid'
import type { KindleDrive, KindleBook, Collection } from '../../preload/api'

const COLLECTIONS_DB_RELATIVE = 'system/collections.db'

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

export function App() {
  const [kindle, setKindle] = useState<KindleDrive | null>(null)
  const [books, setBooks] = useState<KindleBook[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [isLoadingDrive, setIsLoadingDrive] = useState(true)
  const [isLoadingBooks, setIsLoadingBooks] = useState(false)
  const [isLoadingCollections, setIsLoadingCollections] = useState(false)

  const loadKindle = useCallback(async () => {
    setIsLoadingDrive(true)
    try {
      const drives = await window.kindleAPI.detectKindleDrives()
      const found = drives[0] ?? null
      setKindle(found)

      if (found) {
        await Promise.all([loadBooks(found.mountpoint), loadCollections(found.mountpoint)])
      } else {
        setBooks([])
        setCollections([])
      }
    } catch (err) {
      console.error('Failed to detect Kindle drives:', err)
    } finally {
      setIsLoadingDrive(false)
    }
  }, [])

  const loadBooks = async (mountpoint: string) => {
    setIsLoadingBooks(true)
    try {
      const result = await window.kindleAPI.readDocuments(mountpoint)
      setBooks(result)
    } catch (err) {
      console.error('Failed to read documents:', err)
      setBooks([])
    } finally {
      setIsLoadingBooks(false)
    }
  }

  const loadCollections = async (mountpoint: string) => {
    const dbPath = joinPath(mountpoint, COLLECTIONS_DB_RELATIVE)
    setIsLoadingCollections(true)
    try {
      const result = await window.kindleAPI.queryCollections(dbPath)
      setCollections(result)
    } catch {
      // Collections DB may not exist on all Kindle models
      setCollections([])
    } finally {
      setIsLoadingCollections(false)
    }
  }

  useEffect(() => {
    loadKindle()
  }, [loadKindle])

  const filteredBooks = selectedCollectionId === null ? books : books

  return (
    <div className="flex h-screen bg-gray-900 text-white overflow-hidden">
      <Sidebar
        collections={collections}
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={setSelectedCollectionId}
        isLoading={isLoadingCollections}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <div>
            <h2 className="text-white font-semibold">
              {selectedCollectionId
                ? collections.find((c) => c.id === selectedCollectionId)?.name ?? 'Collezione'
                : 'Tutti i libri'}
            </h2>
            {kindle && (
              <p className="text-gray-500 text-xs mt-0.5">
                {kindle.description} — {kindle.mountpoint}
              </p>
            )}
          </div>

          <button
            onClick={loadKindle}
            disabled={isLoadingDrive}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50"
          >
            <svg
              className={`w-3.5 h-3.5 ${isLoadingDrive ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Aggiorna
          </button>
        </header>

        <BooksGrid
          books={filteredBooks}
          isLoading={isLoadingBooks}
          kindleConnected={kindle !== null}
        />
      </main>
    </div>
  )
}
