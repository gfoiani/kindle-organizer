import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export function About() {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    window.kindleAPI
      .getAppVersion()
      .then((v) => { if (!cancelled) setVersion(v) })
      .catch((err) => console.error('Failed to read app version:', err))
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <header className="px-6 py-4 border-b border-gray-700 shrink-0">
        <h2 className="text-white font-semibold">{t('about.title')}</h2>
      </header>

      <div className="flex-1 overflow-y-auto scroll-smooth p-6 min-h-0">
        <div className="max-w-2xl mx-auto space-y-8 pb-6">
          {/* App Header */}
          <div className="text-center py-4">
            <div className="w-24 h-24 mx-auto mb-4 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-lg flex items-center justify-center">
              <svg
                className="w-12 h-12 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">{t('about.appName')}</h1>
            <p className="text-gray-400 text-sm">{t('about.version', { version })}</p>
            <p className="text-gray-500 text-sm mt-2">{t('about.description')}</p>
          </div>

          {/* Description */}
          <div>
            <p className="text-gray-300 text-sm leading-relaxed">
              {t('about.descriptionLong')}
            </p>
          </div>

          {/* Features */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('about.features')}</h3>
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((num) => (
                <div key={num} className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <p className="text-gray-400 text-sm pt-0.5">
                    {t(`about.feature${num}`)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Technologies */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('about.technologies')}</h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { name: 'Electron', icon: '⚛️' },
                { name: 'React 19', icon: '⚛️' },
                { name: 'TypeScript', icon: '📘' },
                { name: 'Tailwind CSS', icon: '🎨' },
                { name: 'i18next', icon: '🌍' },
                { name: 'Vite', icon: '⚡' }
              ].map((tech) => (
                <div
                  key={tech.name}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex items-center gap-2 hover:border-indigo-500 transition-colors"
                >
                  <span className="text-lg">{tech.icon}</span>
                  <span className="text-gray-300 text-sm font-medium">{tech.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Links */}
          <div>
            <h3 className="text-white font-semibold mb-4">{t('about.credits')}</h3>
            <div className="space-y-2">
              <a
                href="https://github.com/yourusername/kindle-organizer"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors text-sm"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v 3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                {t('about.github')}
              </a>
              <a
                href="https://opensource.org/licenses/MIT"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors text-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                {t('about.license')}
              </a>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-gray-700 text-center">
            <p className="text-gray-400 text-xs">
              {t('about.tagline')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
