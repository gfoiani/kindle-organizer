import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import path from 'path'
import { format } from 'util'

/**
 * Keeps the main process's errors and warnings in a file the user can send.
 *
 * In a packaged app `console.error` goes nowhere a user can see, and the
 * dev-only `debug()` helpers are silent, so a bug report used to arrive with
 * no trace at all. Installing the file log tees `console.error` and
 * `console.warn` — which every module already uses for real failures — into
 * `<logs>/main.log`, without touching any call site.
 */

const LOG_FILE = 'main.log'
const PREVIOUS_LOG_FILE = 'main.old.log'
/** Past this size the log is rotated: one previous file is kept. */
const DEFAULT_MAX_BYTES = 1024 * 1024

export interface FileLogOptions {
  maxBytes?: number
}

type Level = 'ERROR' | 'WARN'

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0 // no log yet
  }
}

function appendLine(dir: string, maxBytes: number, level: Level, args: unknown[]): void {
  const file = path.join(dir, LOG_FILE)
  // util.format renders an Error with its stack, like the console does.
  const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`
  if (sizeOf(file) + Buffer.byteLength(line) > maxBytes) {
    renameSync(file, path.join(dir, PREVIOUS_LOG_FILE))
  }
  appendFileSync(file, line, 'utf-8')
}

/**
 * Tees `console.error` / `console.warn` into `<dir>/main.log`. Returns the
 * function that puts the console back. Writing the log never throws: a full
 * or read-only disk must not turn every logged error into a crash.
 */
export function installFileLog(dir: string, options: FileLogOptions = {}): () => void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const originalError = console.error
  const originalWarn = console.warn
  let canWrite = true
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    canWrite = false
    originalError(`[logger] Cannot create the log folder ${dir}:`, err)
  }

  const tee =
    (original: (...args: unknown[]) => void, level: Level) =>
    (...args: unknown[]): void => {
      original(...args)
      if (!canWrite) return
      try {
        appendLine(dir, maxBytes, level, args)
      } catch (err) {
        original('[logger] Cannot write the log file:', err)
      }
    }

  console.error = tee(originalError, 'ERROR')
  console.warn = tee(originalWarn, 'WARN')
  return () => {
    console.error = originalError
    console.warn = originalWarn
  }
}
