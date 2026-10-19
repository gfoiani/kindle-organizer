import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export interface CollectionView {
  /** The collection the grid is narrowed to, or null for every book. */
  selectedCollectionId: string | null
  setSelectedCollectionId: Dispatch<SetStateAction<string | null>>
  /** Book keys in the selected collection (empty when none is selected). */
  collectionBookPaths: Set<string>
  setCollectionBookPaths: Dispatch<SetStateAction<Set<string>>>
  /** Back to every book — when the device changes, its collections do too. Stable. */
  resetCollectionView: () => void
}

/** Which collection narrows the grid, and the books it holds. */
export function useCollectionView(reportError: (err: unknown, fallbackKey: string) => void): CollectionView {
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [collectionBookPaths, setCollectionBookPaths] = useState<Set<string>>(new Set())

  const resetCollectionView = useCallback(() => {
    setSelectedCollectionId(null)
    setCollectionBookPaths(new Set())
  }, [])

  useEffect(() => {
    if (selectedCollectionId === null) {
      setCollectionBookPaths(new Set())
      return
    }

    window.kindleAPI
      .getCollectionBooks(selectedCollectionId)
      .then((paths) => setCollectionBookPaths(new Set(paths)))
      .catch((err) => {
        reportError(err, 'errors.loadCollections')
        setCollectionBookPaths(new Set())
      })
  }, [selectedCollectionId, reportError])

  return {
    selectedCollectionId,
    setSelectedCollectionId,
    collectionBookPaths,
    setCollectionBookPaths,
    resetCollectionView
  }
}
