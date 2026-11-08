import { useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface InstallSyncDialogProps {
  isInstalling: boolean
  onInstall: () => void
  onCancel: () => void
}

const BUTTON = 'px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-50'

/**
 * Confirms installing the collection sync on a jb.sh Kindle: what it puts on
 * the device, the one restart it needs, and that it is experimental and runs
 * with the jailbreak's system rights.
 */
export function InstallSyncDialog({ isInstalling, onInstall, onCancel }: InstallSyncDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(dialogRef, { onEscape: isInstalling ? undefined : onCancel, trapTab: true })

  return (
    <div className="app-no-drag fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col gap-3 p-5"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-white font-semibold">
          {t('kindleSync.install.title')}
          <span className="uppercase tracking-wide text-[10px] text-indigo-300 border border-indigo-500/60 rounded px-1.5 py-0.5">
            {t('kindleSync.experimental')}
          </span>
        </h2>
        <p className="text-gray-300 text-sm">{t('kindleSync.install.intro')}</p>
        <p className="text-gray-300 text-sm">{t('kindleSync.install.restart')}</p>
        <p className="text-amber-200 text-sm">{t('kindleSync.install.risk')}</p>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={isInstalling} className={`${BUTTON} bg-gray-700 hover:bg-gray-600 text-gray-200`}>
            {t('kindleSync.install.cancel')}
          </button>
          <button type="button" onClick={onInstall} disabled={isInstalling} className={`${BUTTON} bg-indigo-600 hover:bg-indigo-500 text-white`}>
            {isInstalling ? t('kindleSync.install.working') : t('kindleSync.install.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
