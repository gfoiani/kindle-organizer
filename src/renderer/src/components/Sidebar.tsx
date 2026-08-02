import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  parseCollectionName,
  formatAuthorCollectionName,
  normalizeKey
} from '../utils/collectionHierarchy'
import type { Collection } from '../../../preload/api'

interface SidebarProps {
  collections: Collection[]
  selectedCollectionId: string | null
  onSelectCollection: (id: string | null) => void
  /** True while a collection, the search box or a presence chip narrows the grid. */
  hasActiveFilters: boolean
  /** Lifts every filter at once — the way back to the full list. */
  onShowAllBooks: () => void
  isLoading: boolean
  /** Books on the device — gates the AI / group-by-author actions below. */
  booksCount: number
  /** What "All books" actually shows: device books plus library-only ones. */
  allBooksCount: number
  onCreateCollection: (name: string) => Promise<void>
  onRenameCollection: (id: string, newName: string) => Promise<void>
  onDeleteCollection: (id: string) => Promise<void>
  /** Cascade-rename a genre and re-prefix its author sub-collections. */
  onRenameGenre: (genreName: string, newName: string) => Promise<void>
  /** Cascade-delete a genre and every author sub-collection under it. */
  onDeleteGenre: (genreName: string) => Promise<void>
  onGroupByAuthor: () => void
  isGroupingByAuthor: boolean
  onSelectSettings: () => void
  onSelectAbout: () => void
  onAIOrganize: () => void
}

/**
 * A top-level genre and its author sub-collections. `genreCollection` is null
 * for an "orphan" genre that exists only as sub-collections (e.g. a Calibre tag
 * "Thriller / X" with no bare "Thriller") — rendered as a non-selectable header.
 */
interface CollectionGroup {
  genreKey: string
  genreName: string
  genreCollection: Collection | null
  children: Collection[]
}

/** Groups a flat collection list into genre → author-children, preserving sort order. */
function groupCollections(collections: Collection[]): CollectionGroup[] {
  const order: string[] = []
  const groups = new Map<string, CollectionGroup>()

  for (const c of collections) {
    const parsed = parseCollectionName(c.name)
    const key = normalizeKey(parsed.genre)
    if (!groups.has(key)) {
      order.push(key)
      groups.set(key, { genreKey: key, genreName: parsed.genre, genreCollection: null, children: [] })
    }
    const group = groups.get(key)!
    if (parsed.author === undefined) {
      groups.set(key, { ...group, genreName: c.name, genreCollection: c })
    } else {
      groups.set(key, { ...group, children: [...group.children, c] })
    }
  }

  return order.map((key) => groups.get(key)!)
}

function EditableCollectionRow({
  collection,
  isSelected,
  onSelect,
  onRename,
  onDelete,
  displayName
}: {
  collection: Collection
  isSelected: boolean
  onSelect: () => void
  onRename: (newName: string) => Promise<void>
  onDelete: () => Promise<void>
  /** Label shown/edited instead of the full name (e.g. just the author for a child row). */
  displayName?: string
}) {
  const { t } = useTranslation()
  const shownName = displayName ?? collection.name
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(shownName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select()
    }
  }, [isEditing])

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setEditValue(shownName)
    setIsEditing(true)
  }

  async function commitEdit() {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== shownName) {
      await onRename(trimmed)
    }
    setIsEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commitEdit()
    if (e.key === 'Escape') setIsEditing(false)
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    const confirmed = window.confirm(
      t('sidebar.confirmDelete', { name: collection.name, count: collection.bookCount })
    )
    if (!confirmed) return
    await onDelete()
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-gray-700 text-white text-sm rounded px-2 py-1 outline-none ring-1 ring-indigo-500 min-w-0"
        />
      </div>
    )
  }

  return (
    <div className="group relative flex items-center">
      <button
        onClick={onSelect}
        className={`flex-1 text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between min-w-0 ${
          isSelected
            ? 'bg-indigo-600 text-white'
            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }`}
      >
        <span className="truncate pr-1">{shownName}</span>
        <span
          className={`text-xs ml-1 shrink-0 ${
            isSelected ? 'text-indigo-200' : 'text-gray-500 group-hover:text-gray-400'
          }`}
        >
          {collection.bookCount}
        </span>
      </button>

      {collection.source === 'local' && (
        <div
          className={`absolute right-1 flex items-center gap-0.5 ${
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          } transition-opacity`}
        >
          <button
            onClick={startEdit}
            title={t('sidebar.rename')}
            aria-label={t('sidebar.rename')}
            className={`p-1 rounded ${
              isSelected ? 'text-indigo-200 hover:text-white hover:bg-indigo-500' : 'text-gray-400 hover:text-gray-300 hover:bg-gray-700'
            } transition-colors`}
          >
            <svg aria-hidden="true" className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            title={t('sidebar.delete')}
            aria-label={t('sidebar.delete')}
            className={`p-1 rounded ${
              isSelected ? 'text-indigo-200 hover:text-red-400 hover:bg-indigo-500' : 'text-gray-400 hover:text-red-400 hover:bg-gray-700'
            } transition-colors`}
          >
            <svg aria-hidden="true" className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/** A genre row with an expand toggle that reveals its author sub-collections. */
function CollectionGroupRow({
  group,
  selectedCollectionId,
  onSelectCollection,
  onRenameChild,
  onDeleteChild,
  onRenameGenre,
  onDeleteGenre
}: {
  group: CollectionGroup
  selectedCollectionId: string | null
  onSelectCollection: (id: string) => void
  onRenameChild: (id: string, newName: string) => Promise<void>
  onDeleteChild: (id: string) => Promise<void>
  onRenameGenre: (genreName: string, newName: string) => Promise<void>
  onDeleteGenre: (genreName: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const { genreCollection, genreName, children } = group

  return (
    <div>
      <div className="flex items-center">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
          aria-expanded={expanded}
          className="p-1 text-gray-500 hover:text-gray-300 transition-colors shrink-0"
        >
          <svg
            aria-hidden="true"
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        {genreCollection ? (
          <div className="flex-1 min-w-0">
            <EditableCollectionRow
              collection={genreCollection}
              isSelected={selectedCollectionId === genreCollection.id}
              onSelect={() => onSelectCollection(genreCollection.id)}
              onRename={(newName) => onRenameGenre(genreName, newName)}
              onDelete={() => onDeleteGenre(genreName)}
            />
          </div>
        ) : (
          <div className="flex-1 px-2 py-2 text-sm text-gray-400 truncate" title={genreName}>
            {genreName}
          </div>
        )}
      </div>

      {expanded && (
        <div className="ml-4 pl-1 border-l border-gray-800">
          {children.map((child) => (
            <EditableCollectionRow
              key={child.id}
              collection={child}
              isSelected={selectedCollectionId === child.id}
              onSelect={() => onSelectCollection(child.id)}
              displayName={parseCollectionName(child.name).author ?? child.name}
              onRename={(typed) =>
                onRenameChild(child.id, formatAuthorCollectionName(genreName, typed) || child.name)
              }
              onDelete={() => onDeleteChild(child.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function NewCollectionInput({ onConfirm, onCancel }: { onConfirm: (name: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleConfirm() {
    const trimmed = value.trim()
    if (trimmed) await onConfirm(trimmed)
    else onCancel()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleConfirm()
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleConfirm}
        onKeyDown={handleKeyDown}
        placeholder={t('sidebar.collectionPlaceholder')}
        className="flex-1 bg-gray-700 text-white text-sm rounded px-2 py-1 outline-none ring-1 ring-indigo-500 placeholder-gray-500 min-w-0"
      />
    </div>
  )
}

export function Sidebar({
  collections,
  selectedCollectionId,
  onSelectCollection,
  hasActiveFilters,
  onShowAllBooks,
  isLoading,
  booksCount,
  allBooksCount,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onRenameGenre,
  onDeleteGenre,
  onGroupByAuthor,
  isGroupingByAuthor,
  onSelectSettings,
  onSelectAbout,
  onAIOrganize
}: SidebarProps) {
  const { t } = useTranslation()
  const [isCreating, setIsCreating] = useState(false)
  // Three states, not two: the full list is showing, a filter is on (so this row
  // is an action), or a collection is selected (so it is just the way back).
  const isShowingEverything = selectedCollectionId === null && !hasActiveFilters
  const groups = groupCollections(collections)

  async function handleCreate(name: string) {
    await onCreateCollection(name)
    setIsCreating(false)
  }

  return (
    <aside className="w-64 bg-gray-900 border-r border-gray-700 flex flex-col h-full shrink-0">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-white font-bold text-lg tracking-tight">{t('sidebar.title')}</h1>
        <p className="text-gray-400 text-xs mt-0.5">{t('sidebar.subtitle')}</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {/* Sticky: with the collection tree expanded this block scrolls away, and
            it is the only way back to the unfiltered list. */}
        <div className="mb-4 sticky top-0 z-10 bg-gray-900 pb-2">
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 mb-1">
            {t('sidebar.library')}
          </p>
          <button
            onClick={onShowAllBooks}
            aria-current={isShowingEverything ? 'true' : undefined}
            title={hasActiveFilters ? t('sidebar.clearFilters') : undefined}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${
              isShowingEverything
                ? 'bg-indigo-600 text-white'
                : hasActiveFilters
                  ? 'bg-indigo-900/40 text-indigo-200 ring-1 ring-indigo-500/60 hover:bg-indigo-800/60 hover:text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {hasActiveFilters && (
                // Funnel with a slash: this click drops the active filters.
                <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 4h18l-7 8v5l-4 2v-7L3 4zM4 20L20 4"
                  />
                </svg>
              )}
              <span className="truncate">
                {hasActiveFilters ? t('sidebar.clearFilters') : t('sidebar.allBooks')}
              </span>
            </span>
            <span
              className={`text-xs shrink-0 ${isShowingEverything ? 'text-indigo-200' : 'text-gray-500'}`}
            >
              {allBooksCount}
            </span>
          </button>
          <button
            onClick={onAIOrganize}
            disabled={booksCount === 0}
            title={t('sidebar.aiOrganize')}
            className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed mt-0.5"
          >
            <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
              />
            </svg>
            {t('sidebar.aiOrganize')}
          </button>
          <button
            onClick={onGroupByAuthor}
            disabled={booksCount === 0 || collections.length === 0 || isGroupingByAuthor}
            title={t('sidebar.groupByAuthor')}
            className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed mt-0.5"
          >
            {isGroupingByAuthor ? (
              <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            )}
            {t('sidebar.groupByAuthor')}
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between px-2 mb-1">
            <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider">
              {t('sidebar.collections')}
            </p>
            <button
              onClick={() => setIsCreating(true)}
              title={t('sidebar.newCollection')}
              aria-label={t('sidebar.newCollection')}
              className="text-gray-400 hover:text-gray-300 transition-colors p-0.5 rounded"
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {isLoading && (
            <div className="px-3 py-2 text-gray-500 text-sm">{t('collectionPicker.loading')}</div>
          )}

          {isCreating && (
            <NewCollectionInput
              onConfirm={handleCreate}
              onCancel={() => setIsCreating(false)}
            />
          )}

          {!isLoading && collections.length === 0 && !isCreating && (
            <div className="px-3 py-2 text-gray-600 text-xs leading-relaxed">
              {t('sidebar.noCollections', { symbol: '+' })}
            </div>
          )}

          {groups.map((group) => {
            // A plain top-level collection with no author children renders flat.
            if (group.children.length === 0 && group.genreCollection) {
              const c = group.genreCollection
              return (
                <EditableCollectionRow
                  key={c.id}
                  collection={c}
                  isSelected={selectedCollectionId === c.id}
                  onSelect={() => onSelectCollection(c.id)}
                  onRename={(newName) => onRenameCollection(c.id, newName)}
                  onDelete={() => onDeleteCollection(c.id)}
                />
              )
            }
            return (
              <CollectionGroupRow
                key={`genre:${group.genreKey}`}
                group={group}
                selectedCollectionId={selectedCollectionId}
                onSelectCollection={onSelectCollection}
                onRenameChild={onRenameCollection}
                onDeleteChild={onDeleteCollection}
                onRenameGenre={onRenameGenre}
                onDeleteGenre={onDeleteGenre}
              />
            )
          })}
        </div>
      </nav>

      <footer className="px-2 py-3 border-t border-gray-700 shrink-0 space-y-2">
        <button
          onClick={onSelectAbout}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-gray-400 hover:text-white hover:bg-gray-800`}
        >
          <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {t('sidebar.about')}
        </button>
        <button
          onClick={onSelectSettings}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-gray-400 hover:text-white hover:bg-gray-800`}
        >
          <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {t('sidebar.settings')}
        </button>
      </footer>
    </aside>
  )
}
