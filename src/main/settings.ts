import { app } from 'electron'
import * as fs from 'fs-extra'
import path from 'path'

/** Kindle-compatible output formats the converter can target. */
export type KindleFormat = 'azw3' | 'mobi'

export interface AppSettings {
  /** Format EPUBs are converted to before upload. Default AZW3 (modern). */
  kindleFormat: KindleFormat
}

const VALID_FORMATS: readonly KindleFormat[] = ['azw3', 'mobi']
const DEFAULT_SETTINGS: AppSettings = { kindleFormat: 'azw3' }

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Narrows an untrusted value to a KindleFormat. */
export function isKindleFormat(value: unknown): value is KindleFormat {
  return typeof value === 'string' && (VALID_FORMATS as readonly string[]).includes(value)
}

/**
 * Reads persisted settings. Tolerant by design: a missing file, malformed JSON,
 * or an unknown/invalid `kindleFormat` all degrade to the AZW3 default rather
 * than throwing, so a corrupt settings file can never wedge the app.
 */
export function getSettings(): AppSettings {
  const settingsPath = getSettingsPath()

  if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_SETTINGS }
    }

    const kindleFormat = (parsed as Record<string, unknown>)['kindleFormat']
    return {
      kindleFormat: isKindleFormat(kindleFormat) ? kindleFormat : DEFAULT_SETTINGS.kindleFormat
    }
  } catch (err) {
    console.error(
      `[settings] Failed to read ${settingsPath}:`,
      err instanceof Error ? err.message : String(err)
    )
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Persists the chosen conversion format. Validates first (invalid input throws a
 * TypeError before any file is touched), then writes atomically (temp file then
 * rename) so a crash mid-write can never leave a half-written settings.json.
 */
export function setKindleFormat(format: KindleFormat): AppSettings {
  if (!isKindleFormat(format)) {
    throw new TypeError(
      `Expected "format" to be one of ${VALID_FORMATS.join(', ')}, got ${String(format)}`
    )
  }

  const next: AppSettings = { ...getSettings(), kindleFormat: format }
  writeSettings(next)
  return next
}

function writeSettings(settings: AppSettings): void {
  const settingsPath = getSettingsPath()
  const tempPath = `${settingsPath}.tmp`

  try {
    fs.ensureDirSync(path.dirname(settingsPath))
    // Atomic write: temp file then rename, mirroring calibre.ts.
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), 'utf-8')
    fs.renameSync(tempPath, settingsPath)
  } catch (err) {
    console.error(
      `[settings] Failed to write ${settingsPath}:`,
      err instanceof Error ? err.message : String(err)
    )
    // Clean up the orphaned temp file so a failed write leaves no stale `.tmp`.
    try {
      fs.removeSync(tempPath)
    } catch (cleanupErr) {
      console.error(
        `[settings] Failed to clean up temp file ${tempPath}:`,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      )
    }
    throw err
  }
}
