import { useState, useRef, useEffect } from 'react'
import type { Collection } from '../../../preload/api'

interface SidebarProps {
  collections: Collection[]
  selectedCollectionId: string | null
  onSelectCollection: (id: string | null) => void
  isLoading: boolean
  onCreateCollection: (name: string) => Promise<void>
  onRenameCollection: (id: string, newName: string) => Promise<void>
  onDeleteCollection: (id: string) => Promise<void>
}

function EditableCollectionRow({
  collection,
  isSelected,
  onSelect,
  onRename,
  onDelete
}: {
  collection: Collection
  isSelected: boolean
  onSelect: () => void
  onRename: (newName: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(collection.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select()
    }
  }, [isEditing])

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setEditValue(collection.name)
    setIsEditing(true)
  }

  async function commitEdit() {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== collection.name) {
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
        <span className="truncate pr-1">{collection.name}</span>
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
            title="Rinomina"
            className={`p-1 rounded ${
              isSelected ? 'text-indigo-200 hover:text-white hover:bg-indigo-500' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            } transition-colors`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            title="Elimina"
            className={`p-1 rounded ${
              isSelected ? 'text-indigo-200 hover:text-red-400 hover:bg-indigo-500' : 'text-gray-500 hover:text-red-400 hover:bg-gray-700'
            } transition-colors`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

function NewCollectionInput({ onConfirm, onCancel }: { onConfirm: (name: string) => Promise<void>; onCancel: () => void }) {
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
        placeholder="Nome collezione..."
        className="flex-1 bg-gray-700 text-white text-sm rounded px-2 py-1 outline-none ring-1 ring-indigo-500 placeholder-gray-500 min-w-0"
      />
    </div>
  )
}

export function Sidebar({
  collections,
  selectedCollectionId,
  onSelectCollection,
  isLoading,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection
}: SidebarProps) {
  const [isCreating, setIsCreating] = useState(false)
  const isAllSelected = selectedCollectionId === null

  async function handleCreate(name: string) {
    await onCreateCollection(name)
    setIsCreating(false)
  }

  return (
    <aside className="w-64 bg-gray-900 border-r border-gray-700 flex flex-col h-full shrink-0">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-white font-bold text-lg tracking-tight">Kindle Manager</h1>
        <p className="text-gray-400 text-xs mt-0.5">La tua libreria Kindle</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        <div className="mb-4">
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 mb-1">
            Libreria
          </p>
          <button
            onClick={() => onSelectCollection(null)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
              isAllSelected
                ? 'bg-indigo-600 text-white'
                : 'text-gray-300 hover:bg-gray-800 hover:text-white'
            }`}
          >
            Tutti i libri
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between px-2 mb-1">
            <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider">
              Collezioni
            </p>
            <button
              onClick={() => setIsCreating(true)}
              title="Nuova collezione"
              className="text-gray-500 hover:text-gray-300 transition-colors p-0.5 rounded"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {isLoading && (
            <div className="px-3 py-2 text-gray-500 text-sm">Caricamento...</div>
          )}

          {isCreating && (
            <NewCollectionInput
              onConfirm={handleCreate}
              onCancel={() => setIsCreating(false)}
            />
          )}

          {!isLoading && collections.length === 0 && !isCreating && (
            <div className="px-3 py-2 text-gray-600 text-xs leading-relaxed">
              Nessuna collezione. Usa il tasto{' '}
              <span className="text-gray-500">+</span> per crearne una, o connetti un Kindle
              con Calibre per importarle automaticamente.
            </div>
          )}

          {collections.map((collection) => (
            <EditableCollectionRow
              key={collection.id}
              collection={collection}
              isSelected={selectedCollectionId === collection.id}
              onSelect={() => onSelectCollection(collection.id)}
              onRename={(newName) => onRenameCollection(collection.id, newName)}
              onDelete={() => onDeleteCollection(collection.id)}
            />
          ))}
        </div>
      </nav>
    </aside>
  )
}
