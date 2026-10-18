import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessageKey } from '../utils/appError'
import { SECONDARY_BUTTON, STATUS_COLORS, type StatusLine } from './settingsUi'
import type { LibraryFolderSummary } from '../../../preload/api'

type Busy = 'adding' | 'syncing' | 'removing' | null

/**
 * The folders on this computer whose books the library reads in place. Adding
 * one goes through the system folder dialog (in the main process); the grid
 * follows through the `library:changed` push, so nothing here reloads it.
 */
export function LibraryFoldersSection() {
  const { t } = useTranslation()
  const [folders, setFolders] = useState<LibraryFolderSummary[]>([])
  const [busy, setBusy] = useState<Busy>(null)
  const [status, setStatus] = useState<StatusLine | null>(null)

  const reload = useCallback(async () => {
    try {
      setFolders(await window.kindleAPI.listLibraryFolders())
    } catch (err) {
      console.error('Failed to list the library folders:', err)
      setStatus({ kind: 'error', text: t('errors.libraryFolders') })
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  // Book counts follow the folder watchers while the panel is open.
  useEffect(() => window.kindleAPI.onLibraryChanged(() => void reload()), [reload])

  async function run(kind: Exclude<Busy, null>, action: () => Promise<StatusLine | null>) {
    setBusy(kind)
    setStatus(null)
    try {
      setStatus(await action())
    } catch (err) {
      console.error(`Library folder action "${kind}" failed:`, err)
      setStatus({ kind: 'error', text: t(errorMessageKey(err, 'settings.libraryFolderError')) })
    } finally {
      setBusy(null)
      await reload()
    }
  }

  const handleAdd = () =>
    run('adding', async () => {
      const linked = await window.kindleAPI.addLibraryFolder()
      return linked ? { kind: 'success', text: t('settings.libraryFolderAdded', { count: linked.result.added }) } : null
    })

  const handleSync = () =>
    run('syncing', async () => {
      await window.kindleAPI.syncLibraryFolders()
      return null
    })

  const handleRemove = (folder: LibraryFolderSummary) => {
    if (!window.confirm(t('settings.removeLibraryFolderConfirm', { path: folder.path }))) return
    void run('removing', async () => {
      await window.kindleAPI.removeLibraryFolder(folder.id)
      return null
    })
  }

  return (
    <div>
      <h3 className="text-white font-semibold mb-4">{t('settings.libraryFolders')}</h3>
      <p className="text-gray-400 text-sm mb-4">{t('settings.libraryFoldersDescription')}</p>

      {folders.length === 0 ? (
        <p className="text-gray-500 text-xs mb-4">{t('settings.libraryFoldersEmpty')}</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {folders.map((folder) => (
            <li
              key={folder.id}
              className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-md px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-200 truncate" title={folder.path}>
                  {folder.path}
                </p>
                <p className="text-xs text-gray-400">
                  {t('settings.libraryFolderBooks', { count: folder.bookCount })}
                  {!folder.available && (
                    <span className="text-amber-300"> · {t('settings.libraryFolderUnavailable')}</span>
                  )}
                </p>
              </div>
              <button onClick={() => handleRemove(folder)} disabled={busy !== null} className={SECONDARY_BUTTON}>
                {t('settings.removeLibraryFolder')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <button onClick={handleAdd} disabled={busy !== null} className={SECONDARY_BUTTON}>
          {busy === 'adding' ? t('settings.addingLibraryFolder') : t('settings.addLibraryFolder')}
        </button>
        {folders.length > 0 && (
          <button onClick={handleSync} disabled={busy !== null} className={SECONDARY_BUTTON}>
            {busy === 'syncing' ? t('settings.syncingLibraryFolders') : t('settings.syncLibraryFolders')}
          </button>
        )}
      </div>

      <p role="status" aria-live="polite" className={`text-xs mt-3 ${status ? STATUS_COLORS[status.kind] : ''}`}>
        {status?.text ?? ''}
      </p>
    </div>
  )
}
