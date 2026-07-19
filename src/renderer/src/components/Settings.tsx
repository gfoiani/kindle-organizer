import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import { STATUS_RESET_MS } from '../utils/constants'
import type { KindleFormat } from '../../../preload/api'

export function Settings() {
  const { t } = useTranslation()
  const [isClearing, setIsClearing] = useState(false)
  const [clearResult, setClearResult] = useState<'success' | 'error' | null>(null)
  const [kindleFormat, setKindleFormatState] = useState<KindleFormat | null>(null)

  useEffect(() => {
    window.kindleAPI
      .getFormat()
      .then(setKindleFormatState)
      .catch((err) => console.error('Failed to load conversion format:', err))
  }, [])

  async function handleFormatChange(format: KindleFormat) {
    const previous = kindleFormat
    setKindleFormatState(format) // optimistic
    try {
      await window.kindleAPI.setFormat(format)
    } catch (err) {
      console.error('Failed to set conversion format:', err)
      setKindleFormatState(previous) // revert on failure
    }
  }

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

          {/* Conversion Format Section */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('settings.conversionFormat')}</h3>
            <p className="text-gray-400 text-sm mb-4">{t('settings.conversionFormatDescription')}</p>
            <div className="flex gap-2">
              <button
                onClick={() => handleFormatChange('azw3')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  kindleFormat === 'azw3'
                    ? 'bg-indigo-600 text-white border border-indigo-500'
                    : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
                }`}
              >
                AZW3
              </button>
              <button
                onClick={() => handleFormatChange('mobi')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  kindleFormat === 'mobi'
                    ? 'bg-indigo-600 text-white border border-indigo-500'
                    : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
                }`}
              >
                MOBI
              </button>
            </div>
            {kindleFormat === 'mobi' && (
              <p className="text-amber-400/80 text-xs mt-3">{t('settings.formatMobiLegacy')}</p>
            )}
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
        </div>
      </div>
    </div>
  )
}
