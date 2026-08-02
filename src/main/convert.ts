import { app } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { KindleFormat } from './settings'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

export type ConversionEngine = 'calibre' | 'bundled' | 'none'

// ─── Error taxonomy (dispatch with instanceof) ───────────────────────────────

/** No conversion engine is available (Calibre missing, no bundled binary). */
export class ConversionUnavailableError extends Error {
  constructor(message = 'No conversion engine available') {
    super(message)
    this.name = 'ConversionUnavailableError'
  }
}

/** The chosen engine cannot produce the requested format (e.g. bundled → MOBI). */
export class UnsupportedFormatError extends Error {
  constructor(
    public readonly format: string,
    message: string
  ) {
    super(message)
    this.name = 'UnsupportedFormatError'
  }
}

/** The converter ran but exited non-zero (or failed to spawn). */
export class ConversionFailedError extends Error {
  constructor(
    public readonly code: number | null,
    public readonly stderrTail: string,
    message?: string
  ) {
    super(message ?? `Conversion failed (exit ${code ?? 'unknown'})`)
    this.name = 'ConversionFailedError'
  }
}

/** Conversion was cancelled via the AbortSignal. Name-matched like requestScheduler. */
export class ConversionAbortError extends Error {
  constructor(message = 'Conversion was cancelled') {
    super(message)
    this.name = 'AbortError'
  }
}

// ─── Engine detection (cached) ────────────────────────────────────────────────

const CALIBRE_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/calibre.app/Contents/MacOS/ebook-convert'],
  win32: [
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Calibre2', 'ebook-convert.exe'),
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Calibre2',
      'ebook-convert.exe'
    )
  ],
  linux: []
}

let cachedEngine: ConversionEngine | undefined
let cachedCalibrePath: string | undefined
let cachedBundledPath: string | undefined

/** Clears the memoized engine detection. Test-only. */
export function resetEngineCache(): void {
  cachedEngine = undefined
  cachedCalibrePath = undefined
  cachedBundledPath = undefined
}

function findCalibre(): string | undefined {
  for (const candidate of CALIBRE_PATHS[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  // PATH fallback (Linux, or a non-standard install on PATH).
  try {
    execFileSync('ebook-convert', ['--version'], { stdio: 'ignore' })
    return 'ebook-convert'
  } catch {
    return undefined
  }
}

/** Absolute path of the bundled converter binary (present only once Phase 6 ships it). */
function bundledBinaryPath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'converter')
    : path.join(process.cwd(), 'resources', 'converter')
  return path.join(dir, process.platform === 'win32' ? 'kindle-cli.exe' : 'kindle-cli')
}

function findBundled(): string | undefined {
  const binary = bundledBinaryPath()
  return existsSync(binary) ? binary : undefined
}

/** Detects (and memoizes) the best available conversion engine. */
export function detectEngine(): ConversionEngine {
  if (cachedEngine !== undefined) return cachedEngine

  const calibre = findCalibre()
  if (calibre) {
    cachedCalibrePath = calibre
    cachedEngine = 'calibre'
    return 'calibre'
  }

  const bundled = findBundled()
  if (bundled) {
    cachedBundledPath = bundled
    cachedEngine = 'bundled'
    return 'bundled'
  }

  cachedEngine = 'none'
  return 'none'
}

// ─── Conversion ───────────────────────────────────────────────────────────────

export interface ConvertOptions {
  /** Where the converted file should end up. */
  outputPath: string
  /** Cancels the conversion (kills the child process). */
  signal?: AbortSignal
  /** Called with an integer percent (0–100) as Calibre reports progress, or never for indeterminate engines. */
  onProgress?: (percent: number) => void
}

const MAX_STDERR_TAIL = 2000

/** Parses a tolerant `\d+%` out of a converter output line. */
function parseProgress(text: string): number | null {
  const match = text.match(/(\d{1,3})\s*%/)
  if (!match) return null
  return Math.max(0, Math.min(100, parseInt(match[1], 10)))
}

function buildArgs(
  engine: ConversionEngine,
  inputPath: string,
  outputPath: string
): { command: string; args: string[] } {
  if (engine === 'calibre') {
    return {
      command: cachedCalibrePath ?? 'ebook-convert',
      args: [inputPath, outputPath, '--output-profile', 'kindle_pw3']
    }
  }
  // Bundled (AZW3 only): writes into the output directory; the caller reconciles
  // the produced filename with outputPath.
  return {
    command: cachedBundledPath ?? bundledBinaryPath(),
    args: ['--no-push', '--out-dir', path.dirname(outputPath), inputPath]
  }
}

/**
 * Converts `inputPath` to `format`, writing to `options.outputPath`. Never
 * spawns a shell (execFile with an argv). Cancellation via `options.signal`
 * kills the child and rejects with an AbortError-named error. Calibre progress
 * is parsed tolerantly from stdout/stderr; other engines stay indeterminate.
 */
export function convert(
  inputPath: string,
  format: KindleFormat,
  options: ConvertOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const engine = detectEngine()

    if (engine === 'none') {
      reject(new ConversionUnavailableError())
      return
    }
    if (engine === 'bundled' && format !== 'azw3') {
      reject(
        new UnsupportedFormatError(
          format,
          `The bundled converter only produces AZW3; ${format.toUpperCase()} requires Calibre.`
        )
      )
      return
    }
    if (options.signal?.aborted) {
      reject(new ConversionAbortError())
      return
    }

    const { command, args } = buildArgs(engine, inputPath, options.outputPath)
    debug(`[convert] ${engine}: ${command} ${args.join(' ')}`)

    const child = execFile(command, args, { maxBuffer: 32 * 1024 * 1024 })
    let stderrTail = ''
    let aborted = false

    const onProgressData = (data: Buffer): void => {
      const text = data.toString()
      const pct = parseProgress(text)
      if (pct !== null && options.onProgress) options.onProgress(pct)
    }
    child.stdout?.on('data', onProgressData)
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-MAX_STDERR_TAIL)
      onProgressData(data)
    })

    const onAbort = (): void => {
      aborted = true
      child.kill()
    }
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      cleanup()
      if (aborted) reject(new ConversionAbortError())
      else reject(new ConversionFailedError(null, stderrTail, err.message))
    })

    child.on('close', (code) => {
      cleanup()
      if (aborted || options.signal?.aborted) {
        reject(new ConversionAbortError())
        return
      }
      if (code === 0) resolve(options.outputPath)
      else reject(new ConversionFailedError(code, stderrTail))
    })
  })
}
