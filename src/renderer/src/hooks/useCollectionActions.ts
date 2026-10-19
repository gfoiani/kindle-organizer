import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { Collection, KindleBook } from '../../../preload/api'
import type { ClassifyResult } from './useClassifier'
import type { CollectionView } from './useCollectionView'
import type { RunOutcome } from './useReportedRun'
import { toBookRelpath } from '../utils/relpath'
import {
  buildAuthorSubcollections,
  formatAuthorCollectionName,
  isSubCollection,
  normalizeKey,
  parseCollectionName,
  sanitizeNamePart,
  type AuthoredBook,
  type CollectionMembership
} from '../utils/collectionHierarchy'

interface CollectionActionsOptions {
  books: KindleBook[]
  collections: Collection[]
  setCollections: Dispatch<SetStateAction<Collection[]>>
  reloadCollections: () => Promise<void>
  view: CollectionView
  run: <T>(fallbackKey: string, action: () => Promise<T>) => Promise<RunOutcome<T>>
  reportError: (err: unknown, fallbackKey: string) => void
}

export interface CollectionActions {
  createCollection: (name: string) => Promise<void>
  renameCollection: (id: string, newName: string) => Promise<void>
  deleteCollection: (id: string) => Promise<void>
  /** Stable: every memoized book card receives it. */
  addBookToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  /** Stable: every memoized book card receives it. */
  removeBookFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  renameGenre: (genreName: string, rawNewName: string) => Promise<void>
  deleteGenre: (genreName: string) => Promise<void>
  groupByAuthor: () => Promise<void>
  isGroupingByAuthor: boolean
  /** Resolves true once the suggestions were applied; throws so the modal can show a failure. */
  applySuggestions: (
    suggestions: ClassifyResult[],
    threshold: number,
    deleteExisting: boolean,
    groupByAuthor: boolean
  ) => Promise<boolean>
}

/** Everything the sidebar, the grid and the AI modal do to collections. */
export function useCollectionActions({
  books,
  collections,
  setCollections,
  reloadCollections,
  view,
  run,
  reportError
}: CollectionActionsOptions): CollectionActions {
  const { selectedCollectionId, setSelectedCollectionId, setCollectionBookPaths } = view
  const [isGroupingByAuthor, setIsGroupingByAuthor] = useState(false)

  async function createCollection(name: string): Promise<void> {
    const result = await run('errors.createCollection', () => window.kindleAPI.createCollection(name))
    if (result.ok) await reloadCollections()
  }

  async function renameCollection(id: string, newName: string): Promise<void> {
    const result = await run('errors.renameCollection', () => window.kindleAPI.renameCollections([{ id, newName }]))
    if (result.ok) setCollections(result.value)
  }

  async function deleteCollection(id: string): Promise<void> {
    // The batch endpoint returns the refreshed list, so no follow-up read.
    const result = await run('errors.deleteCollection', () => window.kindleAPI.deleteCollections([id]))
    if (!result.ok) return
    if (selectedCollectionId === id) setSelectedCollectionId(null)
    setCollections(result.value)
  }

  // Stable: a new identity on each App render (every keystroke in the search
  // box) re-rendered every memoized BookCard.
  const addBookToCollection = useCallback(
    async (collectionId: string, bookRelpath: string) => {
      const result = await run('errors.addToCollection', () =>
        window.kindleAPI.addBookToCollection(collectionId, bookRelpath)
      )
      // Only reflect the membership once it actually landed — the optimistic
      // update used to stick even when the write had failed.
      if (!result.ok) return
      if (collectionId === selectedCollectionId) {
        setCollectionBookPaths((prev) => new Set([...prev, bookRelpath]))
      }
      await reloadCollections()
    },
    [run, selectedCollectionId, setCollectionBookPaths, reloadCollections]
  )

  const removeBookFromCollection = useCallback(
    async (collectionId: string, bookRelpath: string) => {
      const result = await run('errors.removeFromCollection', () =>
        window.kindleAPI.removeBookFromCollection(collectionId, bookRelpath)
      )
      if (!result.ok) return
      if (collectionId === selectedCollectionId) {
        setCollectionBookPaths((prev) => {
          const next = new Set(prev)
          next.delete(bookRelpath)
          return next
        })
      }
      await reloadCollections()
    },
    [run, selectedCollectionId, setCollectionBookPaths, reloadCollections]
  )

  async function applySuggestions(
    suggestions: ClassifyResult[],
    threshold: number,
    deleteExisting: boolean,
    groupByAuthor: boolean
  ): Promise<boolean> {
    const filtered = suggestions.filter((s) => s.score * 100 >= threshold)
    if (filtered.length === 0) return false

    try {
      // Optionally wipe existing collections before creating new ones. Skip
      // Calibre-sourced collections: the next sync resurrects them anyway, so
      // deleting them here just churns state. One transactional call, so this
      // can no longer half-wipe the list part-way through.
      if (deleteExisting) {
        const ids = collections.filter((c) => c.source !== 'calibre').map((c) => c.id)
        if (ids.length > 0) await window.kindleAPI.deleteCollections(ids)
      }

      // Group the accepted suggestions by label, then hand every genre AND every
      // author sub-collection to the idempotent batch writer in ONE call.
      const byGenre = new Map<string, string[]>()
      for (const suggestion of filtered) {
        const relpath = toBookRelpath(suggestion.book)
        byGenre.set(suggestion.label, [...(byGenre.get(suggestion.label) ?? []), relpath])
      }
      const genreEntries: CollectionMembership[] = [...byGenre].map(([name, relpaths]) => ({ name, relpaths }))

      // Author sub-collections (e.g. "Thriller / Glenn Cooper") for the genres
      // that have 2+ distinct authors.
      const authorEntries = groupByAuthor
        ? buildAuthorSubcollections(
            filtered.map((s) => ({ genre: s.label, author: s.book.author, relpath: toBookRelpath(s.book) }))
          )
        : []

      const next = await window.kindleAPI.ensureCollectionsContain([...genreEntries, ...authorEntries])
      setCollections(next)
      // A wipe can delete the collection currently being viewed.
      setSelectedCollectionId((prev) => (prev && next.some((c) => c.id === prev) ? prev : null))
      return true
    } catch (err) {
      console.error('Failed to apply AI suggestions:', err)
      // Re-throw so the modal can surface the failure to the user.
      throw err
    }
  }

  // Standalone "group by author": materialize author sub-collections for the
  // genres that already exist (including Calibre-imported ones) without re-running
  // the classifier. Reads current membership once, joins each book's author from
  // state, and lets the idempotent batch writer create the subs.
  async function groupByAuthor(): Promise<void> {
    if (collections.length === 0 || books.length === 0) return
    setIsGroupingByAuthor(true)
    try {
      const relpaths = books.map((b) => toBookRelpath(b))
      const authorByRelpath = new Map(relpaths.map((rp, i) => [rp, books[i].author]))
      const tagsByRelpath = await window.kindleAPI.getBookTags(relpaths)

      const authored: AuthoredBook[] = []
      for (const [relpath, names] of Object.entries(tagsByRelpath)) {
        const author = authorByRelpath.get(relpath)
        if (!author || !author.trim()) continue
        for (const name of names) {
          if (isSubCollection(name)) continue // only group under top-level genres
          authored.push({ genre: name, author, relpath })
        }
      }

      const payload = buildAuthorSubcollections(authored)
      if (payload.length > 0) {
        setCollections(await window.kindleAPI.ensureCollectionsContain(payload))
      }
    } catch (err) {
      reportError(err, 'errors.groupByAuthor')
    } finally {
      setIsGroupingByAuthor(false)
    }
  }

  // Collections whose genre matches `genreName` (the bare genre row plus every
  // "<genre> / <author>" child), used for cascade rename/delete.
  function collectionsInGenre(genreName: string): Collection[] {
    const key = normalizeKey(genreName)
    return collections.filter((c) => normalizeKey(parseCollectionName(c.name).genre) === key)
  }

  // Delete a genre and every author sub-collection under it, in one transaction.
  async function deleteGenre(genreName: string): Promise<void> {
    const toDelete = collectionsInGenre(genreName)
    if (toDelete.length === 0) return

    const result = await run('errors.deleteGenre', () => window.kindleAPI.deleteCollections(toDelete.map((c) => c.id)))
    if (!result.ok) return
    if (toDelete.some((c) => c.id === selectedCollectionId)) setSelectedCollectionId(null)
    setCollections(result.value)
  }

  // Rename a genre and re-prefix its author sub-collections. The whole tree goes
  // in a single transaction: a name collision rolls every rename back (and is
  // reported), instead of the old per-item loop that could stop half-way.
  async function renameGenre(genreName: string, rawNewName: string): Promise<void> {
    const newGenre = sanitizeNamePart(rawNewName)
    if (!newGenre || normalizeKey(newGenre) === normalizeKey(genreName)) return

    const targets = collectionsInGenre(genreName)
      .map((c) => {
        const parsed = parseCollectionName(c.name)
        return {
          id: c.id,
          newName: parsed.author === undefined ? newGenre : formatAuthorCollectionName(newGenre, parsed.author)
        }
      })
      .filter((target) => target.newName !== '')

    if (targets.length === 0) return

    const result = await run('errors.renameGenre', () => window.kindleAPI.renameCollections(targets))
    if (result.ok) setCollections(result.value)
  }

  return {
    createCollection,
    renameCollection,
    deleteCollection,
    addBookToCollection,
    removeBookFromCollection,
    renameGenre,
    deleteGenre,
    groupByAuthor,
    isGroupingByAuthor,
    applySuggestions
  }
}
