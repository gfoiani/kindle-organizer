import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BOOK_SORT_ORDERS, isBookSortOrder, type BookSortOrder } from '../utils/sortBooks'

const SORT_STORAGE_KEY = 'bookSortOrder'
const DEFAULT_SORT_ORDER: BookSortOrder = 'title'
const SORT_LABEL_KEYS: Record<BookSortOrder, string> = {
  title: 'books.sortTitle',
  author: 'books.sortAuthor',
  recent: 'books.sortRecent'
}

/** The order the user last picked; a convenience, so unavailable storage just means the default. */
function readStoredSortOrder(): BookSortOrder {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY)
    return isBookSortOrder(stored) ? stored : DEFAULT_SORT_ORDER
  } catch (err) {
    console.error('[sort] Cannot read the saved order:', err)
    return DEFAULT_SORT_ORDER
  }
}

function storeSortOrder(order: BookSortOrder): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, order)
  } catch (err) {
    console.error('[sort] Cannot save the order:', err)
  }
}

/** The grid's sort order, remembered across launches. */
export function useBookSortOrder(): [BookSortOrder, (order: BookSortOrder) => void] {
  const [order, setOrder] = useState<BookSortOrder>(readStoredSortOrder)
  const change = useCallback((next: BookSortOrder) => {
    setOrder(next)
    storeSortOrder(next)
  }, [])
  return [order, change]
}

interface SortSelectProps {
  value: BookSortOrder
  onChange: (order: BookSortOrder) => void
}

export function SortSelect({ value, onChange }: SortSelectProps) {
  const { t } = useTranslation()
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap">
      {t('books.sortBy')}
      <select
        value={value}
        onChange={(e) => {
          if (isBookSortOrder(e.target.value)) onChange(e.target.value)
        }}
        className="bg-gray-800 border border-gray-700 rounded-md px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-indigo-500 transition-colors"
      >
        {BOOK_SORT_ORDERS.map((order) => (
          <option key={order} value={order}>
            {t(SORT_LABEL_KEYS[order])}
          </option>
        ))}
      </select>
    </label>
  )
}
