import { useTranslation } from 'react-i18next'
import type { KindleDrive } from '../../../preload/api'
import type { DeviceActions } from '../hooks/useDeviceActions'

interface AppHeaderProps {
  /** The collection shown, or "All books". */
  title: string
  kindle: KindleDrive | null
  /** Any device reload in flight: the Refresh spinner is its only progress cue. */
  isRefreshing: boolean
  onRefresh: () => void
  /** Write and eject, owned by App so their state outlives this header. */
  actions: DeviceActions
}

const SPIN_PATH =
  'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'

function Icon({ path, spin = false }: { path: string; spin?: boolean }) {
  return (
    <svg aria-hidden="true" className={`w-3.5 h-3.5 ${spin ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  )
}

const PLAIN_BUTTON =
  'flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50'

/** The grid's header: what is shown, and the device actions (write collections, eject, refresh). */
export function AppHeader({ title, kindle, isRefreshing, onRefresh, actions }: AppHeaderProps) {
  const { t } = useTranslation()
  const { isSyncing, isEjecting, syncResult } = actions

  const syncLabel =
    syncResult === 'success' ? t('header.saved') : syncResult === 'error' ? t('header.error') : t('header.writeKindle')

  return (
    <>
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
        <div>
          <h2 className="text-white font-semibold">{title}</h2>
          {kindle && (
            <p className="text-gray-500 text-xs mt-0.5">
              {kindle.description} — {kindle.mountpoint}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {kindle && (
            <button
              onClick={actions.writeToKindle}
              disabled={isSyncing}
              title={t('header.writeToKindle')}
              aria-label={t('header.writeToKindle')}
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-md text-sm transition-colors disabled:opacity-50 ${
                syncResult === 'success'
                  ? 'bg-green-800 border-green-600 text-green-200'
                  : syncResult === 'error'
                    ? 'bg-red-900 border-red-700 text-red-300'
                    : 'bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-300'
              }`}
            >
              {isSyncing ? (
                <Icon path={SPIN_PATH} spin />
              ) : syncResult === 'success' ? (
                <Icon path="M5 13l4 4L19 7" />
              ) : syncResult === 'error' ? (
                <Icon path="M6 18L18 6M6 6l12 12" />
              ) : (
                <Icon path="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              )}
              {syncLabel}
            </button>
          )}

          {kindle && (
            <button
              onClick={actions.eject}
              disabled={isEjecting || isSyncing}
              title={t('header.ejectHint')}
              aria-label={t('header.eject')}
              className={PLAIN_BUTTON}
            >
              {/* The standard eject glyph: triangle over a bar. */}
              {isEjecting ? <Icon path={SPIN_PATH} spin /> : <Icon path="M5 13l7-7 7 7H5zM5 18h14" />}
              {isEjecting ? t('header.ejecting') : t('header.eject')}
            </button>
          )}

          <button onClick={onRefresh} disabled={isRefreshing} aria-label={t('header.refresh')} className={PLAIN_BUTTON}>
            <Icon path={SPIN_PATH} spin={isRefreshing} />
            {t('header.refresh')}
          </button>
        </div>
      </header>

      {/* Visually-hidden live region announces the write-to-Kindle result. */}
      <div role="status" aria-live="polite" className="sr-only">
        {syncResult === 'success' ? t('header.saved') : syncResult === 'error' ? t('header.error') : ''}
      </div>
    </>
  )
}
