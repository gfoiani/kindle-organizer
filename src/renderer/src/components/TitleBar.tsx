import { useTranslation } from 'react-i18next'

/**
 * Bar height in px. MUST stay in sync with `TITLE_BAR_HEIGHT` in
 * `src/main/index.ts` — on Windows/Linux the native window-control overlay is
 * drawn at that height, and a mismatch leaves the buttons clipped or floating.
 */
const TITLE_BAR_HEIGHT_PX = 38

/**
 * Horizontal space kept free for the platform's window controls: macOS traffic
 * lights on the left, the Windows/Linux minimise-maximise-close overlay on the
 * right. Reserved on BOTH sides so the title stays centred on the window like a
 * native bar — padding one side only would shove it off-centre by half.
 */
const MAC_TRAFFIC_LIGHTS_WIDTH_PX = 78
const WINDOW_CONTROLS_WIDTH_PX = 140

/**
 * The app-drawn title bar.
 *
 * The native one is hidden on every platform (see `themedWindowChrome` in
 * `src/main/index.ts`) so the top of the window is painted in the app theme
 * instead of following the OS light/dark appearance.
 *
 * The strip is one big drag region. Anything interactive inside it — and any
 * overlay that covers it, such as a full-window modal backdrop — must carry
 * `.app-no-drag`, because Chromium computes the draggable area as drag-rects
 * minus no-drag-rects and a draggable rect swallows every pointer event.
 */
export function TitleBar() {
  const { t } = useTranslation()
  const isMac = window.kindleAPI.platform === 'darwin'
  const controlsWidth = isMac ? MAC_TRAFFIC_LIGHTS_WIDTH_PX : WINDOW_CONTROLS_WIDTH_PX

  // Windows/Linux only: hiding the native title bar makes the window frameless,
  // and Electron does not draw a menu bar for frameless windows. The menu's
  // accelerators still work, but this button is its only pointer affordance.
  // macOS keeps its menu in the system bar, so no button is rendered there.
  const handleOpenMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const { left, bottom } = event.currentTarget.getBoundingClientRect()
    window.kindleAPI.popupAppMenu(left, bottom).catch((err) => {
      console.error('[menu:popup]', err)
    })
  }

  return (
    <div
      className="app-drag-region relative shrink-0 flex items-center justify-center bg-gray-900 border-b border-gray-800"
      style={{
        height: TITLE_BAR_HEIGHT_PX,
        paddingLeft: controlsWidth,
        paddingRight: controlsWidth
      }}
    >
      {!isMac && (
        <button
          type="button"
          onClick={handleOpenMenu}
          aria-label={t('menu.open')}
          title={t('menu.open')}
          className="app-no-drag absolute left-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <svg
            aria-hidden="true"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      {/* Decorative: the same name is already the sidebar's <h1>, so screen
          readers would otherwise announce it twice. */}
      <span aria-hidden="true" className="text-gray-400 text-xs font-medium tracking-wide truncate">
        {t('app.title')}
      </span>
    </div>
  )
}
