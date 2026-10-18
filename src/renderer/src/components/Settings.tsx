import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import { STATUS_RESET_MS } from '../utils/constants'
import { errorMessageKey } from '../utils/appError'
import type { CalibreBackupSummary } from '../../../preload/api'

interface SettingsProps {
  /** Connected device mountpoint, or null when no Kindle is attached. */
  mountpoint: string | null
  /** Fired after metadata.calibre was restored, so the app re-reads the device. */
  onCollectionsRestored: () => void
}

interface StatusLine {
  kind: 'success' | 'info' | 'error'
  text: string
}

const STATUS_COLORS: Record<StatusLine['kind'], string> = {
  success: 'text-green-300',
  info: 'text-gray-300',
  error: 'text-red-300'
}

const SECONDARY_BUTTON =
  'px-4 py-2 rounded-md text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-600 transition-colors disabled:opacity-50'

const formatTakenAt = (takenAt: string): string => new Date(takenAt).toLocaleString(i18next.language)

/** The metadata.calibre backups kept on the Kindle, reloaded whenever the device changes. */
function useDeviceBackups(mountpoint: string | null): {
  backups: CalibreBackupSummary[]
  reload: () => Promise<void>
  loadFailed: boolean
} {
  const [backups, setBackups] = useState<CalibreBackupSummary[]>([])
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = useCallback(async () => {
    setLoadFailed(false)
    if (!mountpoint) {
      setBackups([])
      return
    }
    try {
      setBackups(await window.kindleAPI.listCollectionsBackups(mountpoint))
    } catch (err) {
      console.error('Failed to list the collections backups:', err)
      setBackups([])
      setLoadFailed(true)
    }
  }, [mountpoint])

  useEffect(() => {
    reload()
  }, [reload])

  return { backups, reload, loadFailed }
}

/** Restores one of the metadata.calibre backups kept on the connected Kindle. */
function DeviceCollectionsSection({ mountpoint, onCollectionsRestored }: SettingsProps) {
  const { t } = useTranslation()
  const { backups, reload, loadFailed } = useDeviceBackups(mountpoint)
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [status, setStatus] = useState<StatusLine | null>(null)
  // The newest copy unless the user picked another that still exists.
  const chosen = backups.find((backup) => backup.id === chosenId) ?? backups[0]

  async function handleRestore() {
    if (!mountpoint || !chosen) return
    if (!window.confirm(t('settings.restoreConfirm', { date: formatTakenAt(chosen.takenAt) }))) return
    setIsRestoring(true)
    setStatus(null)
    try {
      const restored = await window.kindleAPI.restoreCollectionsBackup(mountpoint, chosen.id)
      setStatus(
        restored
          ? { kind: 'success', text: t('settings.restoreDone', { date: formatTakenAt(restored.takenAt) }) }
          : { kind: 'info', text: t('settings.restoreNone') }
      )
      if (restored) onCollectionsRestored()
    } catch (err) {
      console.error('Failed to restore the collections backup:', err)
      setStatus({ kind: 'error', text: t(errorMessageKey(err, 'settings.restoreError')) })
    } finally {
      setIsRestoring(false)
      setChosenId(null)
      await reload()
    }
  }

  return (
    <div>
      <h3 className="text-white font-semibold mb-4">{t('settings.deviceCollections')}</h3>
      <p className="text-gray-400 text-sm mb-4">{t('settings.deviceCollectionsDescription')}</p>
      {mountpoint && backups.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            {t('settings.backupLabel')}
            <select
              value={chosen?.id ?? ''}
              onChange={(e) => setChosenId(e.target.value)}
              disabled={isRestoring}
              className="bg-gray-800 border border-gray-600 rounded-md px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
            >
              {backups.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {formatTakenAt(backup.takenAt)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={handleRestore} disabled={isRestoring} className={SECONDARY_BUTTON}>
            {isRestoring ? t('settings.restoring') : t('settings.restoreBackup')}
          </button>
        </div>
      )}
      {mountpoint && backups.length === 0 && (
        <p className="text-gray-500 text-xs">{t(loadFailed ? 'settings.backupsError' : 'settings.restoreNone')}</p>
      )}
      {!mountpoint && <p className="text-gray-500 text-xs">{t('settings.restoreNeedsKindle')}</p>}
      <p role="status" aria-live="polite" className={`text-xs mt-3 ${status ? STATUS_COLORS[status.kind] : ''}`}>
        {status?.text ?? ''}
      </p>
    </div>
  )
}

/** Points the user at main.log, to attach to a bug report. */
function DiagnosticsSection() {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)

  async function handleOpenLogs() {
    setFailed(false)
    try {
      await window.kindleAPI.openLogsFolder()
    } catch (err) {
      console.error('Failed to open the logs folder:', err)
      setFailed(true)
    }
  }

  return (
    <div>
      <h3 className="text-white font-semibold mb-4">{t('settings.diagnostics')}</h3>
      <p className="text-gray-400 text-sm mb-4">{t('settings.diagnosticsDescription')}</p>
      <button onClick={handleOpenLogs} className={SECONDARY_BUTTON}>
        {t('settings.openLogs')}
      </button>
      {failed && (
        <p role="alert" className="text-red-300 text-xs mt-3">
          {t('settings.openLogsError')}
        </p>
      )}
    </div>
  )
}

export function Settings({ mountpoint, onCollectionsRestored }: SettingsProps) {
  const { t } = useTranslation()
  const [isClearing, setIsClearing] = useState(false)
  const [clearResult, setClearResult] = useState<'success' | 'error' | null>(null)

  async function handleClearCache() {
    setIsClearing(true)
    setClearResult(null)
    try {
      await window.kindleAPI.clearCoverCache()
      setClearResult('success')
    } catch (err) {
      console.error('Failed to clear cover cache:', err)
      setClearResult('error')
    } finally {
      setIsClearing(false)
      setTimeout(() => setClearResult(null), STATUS_RESET_MS)
    }
  }

  function handleLanguageChange(lang: string) {
    i18next.changeLanguage(lang)
    localStorage.setItem('language', lang)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <header className="px-6 py-4 border-b border-gray-700 shrink-0">
        <h2 className="text-white font-semibold">{t('settings.title')}</h2>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-8">
          {/* Language Section */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('settings.language')}</h3>
            <div className="flex gap-2">
              <button
                onClick={() => handleLanguageChange('it')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  i18next.language === 'it'
                    ? 'bg-indigo-600 text-white border border-indigo-500'
                    : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
                }`}
              >
                Italiano
              </button>
              <button
                onClick={() => handleLanguageChange('en')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  i18next.language === 'en'
                    ? 'bg-indigo-600 text-white border border-indigo-500'
                    : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
                }`}
              >
                English
              </button>
            </div>
          </div>

          {/* Cover Cache Section */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('settings.coverCache')}</h3>
            <p className="text-gray-400 text-sm mb-4">
              {t('settings.cacheCoverDescription')}
            </p>

            <button
              onClick={handleClearCache}
              disabled={isClearing}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                clearResult === 'success'
                  ? 'bg-green-800 border border-green-600 text-green-200'
                  : clearResult === 'error'
                    ? 'bg-red-900 border border-red-700 text-red-300'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-500'
              } disabled:opacity-50`}
            >
              {isClearing ? (
                <svg aria-hidden="true" className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              ) : clearResult === 'success' ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : clearResult === 'error' ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              )}
              {isClearing
                ? t('settings.clearingCache')
                : clearResult === 'success'
                  ? t('settings.cacheCleared')
                  : clearResult === 'error'
                    ? t('settings.cacheError')
                    : t('settings.clearCache')}
            </button>

            <p className="text-gray-400 text-xs mt-3">
              {t('settings.cacheInfo')}
            </p>

            {/* Visually-hidden live region announces the clear-cache result. */}
            <div role="status" aria-live="polite" className="sr-only">
              {clearResult === 'success'
                ? t('settings.cacheCleared')
                : clearResult === 'error'
                  ? t('settings.cacheError')
                  : ''}
            </div>
          </div>

          <DeviceCollectionsSection mountpoint={mountpoint} onCollectionsRestored={onCollectionsRestored} />
          <DiagnosticsSection />
        </div>
      </div>
    </div>
  )
}
