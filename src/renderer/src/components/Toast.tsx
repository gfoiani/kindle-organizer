import { useTranslation } from 'react-i18next'
import type { Notice } from '../hooks/useNotice'

interface ToastProps {
  notice: Notice | null
  onDismiss: () => void
}

/**
 * The window-level transient message (see `useNotice`).
 *
 * Two separate live regions, always mounted: screen readers only announce a
 * CHANGE inside an existing region, so rendering them conditionally alongside
 * the toast would make the first message silent. Errors get `assertive` because
 * they report an action that did not happen; info stays `polite`.
 */
export function Toast({ notice, onDismiss }: ToastProps) {
  const { t } = useTranslation()
  const isError = notice?.kind === 'error'

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {notice && !isError ? notice.message : ''}
      </div>
      <div role="alert" aria-live="assertive" className="sr-only">
        {notice && isError ? notice.message : ''}
      </div>

      {notice && (
        <div
          className={`fixed bottom-4 right-4 z-40 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg max-w-xs ${
            isError
              ? 'bg-red-950 border-red-700 text-red-200'
              : 'bg-gray-800 border-gray-600 text-gray-200'
          }`}
        >
          {isError && (
            <svg
              aria-hidden="true"
              className="w-4 h-4 shrink-0 mt-0.5 text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          )}
          <span className="flex-1 min-w-0">{notice.message}</span>
          <button
            onClick={onDismiss}
            aria-label={t('notice.dismiss')}
            title={t('notice.dismiss')}
            className={`shrink-0 -mr-1 -mt-0.5 p-0.5 rounded transition-colors ${
              isError ? 'text-red-400 hover:text-red-200' : 'text-gray-400 hover:text-white'
            }`}
          >
            <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  )
}
