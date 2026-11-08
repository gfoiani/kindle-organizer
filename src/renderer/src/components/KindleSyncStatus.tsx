import { useTranslation } from 'react-i18next'
import type { KindleSyncTone, KindleSyncView } from '../utils/kindleSyncView'

interface KindleSyncStatusProps {
  view: KindleSyncView
  onOpenFirstSync: () => void
}

const TONE_CLASSES: Record<KindleSyncTone, string> = {
  ok: 'text-emerald-300 border-emerald-700/60 bg-emerald-900/20',
  pending: 'text-amber-200 border-amber-700/60 bg-amber-900/20',
  warning: 'text-red-300 border-red-700/60 bg-red-900/20',
  muted: 'text-gray-400 border-gray-700 bg-gray-800/60',
  action: 'text-indigo-100 border-indigo-500 bg-indigo-900/40 hover:bg-indigo-800/60 transition-colors'
}

/**
 * The header's collection-sync status, labelled experimental. Its explanation
 * is the tooltip for the mouse and screen-reader text for everyone else; while
 * the first-sync question is due it is a button that opens it.
 */
export function KindleSyncStatus({ view, onOpenFirstSync }: KindleSyncStatusProps) {
  const { t } = useTranslation()
  const hint = t(view.hintKey, view.hintValues)
  const className = `flex items-center gap-2 px-2.5 py-1 rounded-full border text-xs ${TONE_CLASSES[view.tone]}`

  const content = (
    <>
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
      <span className="truncate">{t(view.labelKey)}</span>
      <span className="uppercase tracking-wide text-[10px] opacity-70 shrink-0">{t('kindleSync.experimental')}</span>
      <span className="sr-only">{hint}</span>
    </>
  )

  if (view.opensFirstSync) {
    return (
      <button type="button" onClick={onOpenFirstSync} title={hint} className={className}>
        {content}
      </button>
    )
  }
  const status = (
    <span role="status" title={hint} className={`${className} min-w-0`}>
      {content}
    </span>
  )
  if (!view.guideUrl) return status
  return (
    <>
      {status}
      {/* Opens in the system browser: the main window's open handler hands http(s) URLs to shell.openExternal. */}
      <a
        href={view.guideUrl}
        target="_blank"
        rel="noreferrer"
        title={t('kindleSync.jailbreakGuideHint')}
        className="shrink-0 text-xs text-indigo-300 hover:text-white underline underline-offset-2"
      >
        {t('kindleSync.jailbreakGuide')}
      </a>
    </>
  )
}
