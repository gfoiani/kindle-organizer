import { app } from 'electron'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

// iTunes search results depend on the storefront country. Matching it to the
// app language greatly improves hit rate for non-US books (e.g. Italian titles).
const LANG_TO_ITUNES_COUNTRY: Record<string, string> = { it: 'it', en: 'us' }
let itunesCountry = 'us'

/** Set by the renderer (via IPC) to align the iTunes storefront with the UI language. */
export function setCoverLocale(lang: string): void {
  itunesCountry = LANG_TO_ITUNES_COUNTRY[lang] ?? 'us'
  debug(`[cover] iTunes storefront set to "${itunesCountry}" for lang "${lang}"`)
}

/** The storefront country iTunes searches use, for covers and metadata alike. */
export function itunesStorefront(): string {
  return itunesCountry
}
