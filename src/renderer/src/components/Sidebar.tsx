import type { Collection } from '../../../preload/api'

interface SidebarProps {
  collections: Collection[]
  selectedCollectionId: string | null
  onSelectCollection: (id: string | null) => void
  isLoading: boolean
}

export function Sidebar({
  collections,
  selectedCollectionId,
  onSelectCollection,
  isLoading
}: SidebarProps) {
  const isAllSelected = selectedCollectionId === null

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
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-2 mb-1">
            Collezioni
          </p>

          {isLoading && (
            <div className="px-3 py-2 text-gray-500 text-sm">Caricamento...</div>
          )}

          {!isLoading && collections.length === 0 && (
            <div className="px-3 py-2 text-gray-600 text-xs leading-relaxed">
              Le collezioni non sono disponibili su questo Kindle. Dalla firmware 5.9+
              sono gestite solo nel cloud Amazon.
            </div>
          )}

          {collections.map((collection) => (
            <button
              key={collection.id}
              onClick={() => onSelectCollection(collection.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between group ${
                selectedCollectionId === collection.id
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="truncate">{collection.name}</span>
              <span
                className={`text-xs ml-2 shrink-0 ${
                  selectedCollectionId === collection.id
                    ? 'text-indigo-200'
                    : 'text-gray-500 group-hover:text-gray-400'
                }`}
              >
                {collection.bookCount}
              </span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  )
}
