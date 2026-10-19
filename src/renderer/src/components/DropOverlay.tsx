import { useTranslation } from 'react-i18next'

/** Shown over the whole window while files are dragged over it. */
export function DropOverlay() {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-indigo-950/70 backdrop-blur-sm pointer-events-none">
      <div className="border-2 border-dashed border-indigo-400 rounded-2xl px-10 py-8 text-center">
        <svg aria-hidden="true" className="w-10 h-10 mx-auto mb-3 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
          />
        </svg>
        <p className="text-indigo-100 text-lg font-medium">{t('library.dropOverlay')}</p>
      </div>
    </div>
  )
}
