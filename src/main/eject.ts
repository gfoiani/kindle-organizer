import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from './appErrors'
import type { KindleDrive } from './kindle'

const execFileAsync = promisify(execFile)

/**
 * The only shape of Windows volume path we will interpolate into a PowerShell
 * command: a bare drive letter. Everything else is refused rather than escaped.
 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\?$/

export interface EjectCommand {
  command: string
  args: string[]
}

/**
 * Builds the platform's eject invocation. Kept pure and separate from running it
 * so the argv — the security-sensitive part — is unit-testable.
 *
 * Everything runs through `execFile` with an argv, never a shell. Windows is the
 * exception that needs care: there is no argv-only eject, so the drive letter is
 * pasted into a PowerShell one-liner and is therefore validated first.
 */
export function ejectCommand(platform: NodeJS.Platform, drive: KindleDrive): EjectCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'diskutil', args: ['eject', drive.mountpoint] }
    case 'win32': {
      if (!WINDOWS_DRIVE_PATH.test(drive.mountpoint)) throw new AppError('EJECT_FAILED')
      const letter = drive.mountpoint.slice(0, 2)
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Namespace(17) is the shell's "My Computer" folder; InvokeVerb('Eject')
          // is the same action as the tray icon, so it needs no elevation.
          `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${letter}').InvokeVerb('Eject')`
        ]
      }
    }
    default:
      // Linux and friends: `eject` takes the mount point directly.
      return { command: 'eject', args: [drive.mountpoint] }
  }
}

/**
 * A volume the system refuses to unmount because something still holds it —
 * `diskutil` calls that a "dissenter", `eject(1)` and Windows just say busy.
 * Worth its own code: it is the one eject failure the user can actually act on.
 */
const BUSY_MARKERS = /dissent|in use|busy|couldn't be unmounted|could not be unmounted/i

/** Picks the code that matches what the system tool complained about. */
export function ejectFailureCode(detail: string): 'EJECT_BUSY' | 'EJECT_FAILED' {
  return BUSY_MARKERS.test(detail) ? 'EJECT_BUSY' : 'EJECT_FAILED'
}

/**
 * Unmounts and powers down a detected Kindle volume.
 *
 * The caller must have matched `drive` against a live detection — this function
 * hands its mountpoint to a system tool, so it is not a place to accept a path
 * that came straight from the renderer.
 */
export async function ejectDrive(drive: KindleDrive): Promise<void> {
  const { command, args } = ejectCommand(process.platform, drive)

  try {
    await execFileAsync(command, args)
  } catch (err) {
    // execFile puts the tool's own words in `message` (and `stderr`); both are
    // logged, because a generic "eject failed" toast is not enough to debug this.
    const detail = err instanceof Error ? err.message : String(err)
    const stderr = typeof (err as { stderr?: unknown })?.stderr === 'string'
      ? (err as { stderr: string }).stderr
      : ''
    console.error(`[eject] "${command}" failed for ${drive.mountpoint}: ${detail} ${stderr}`.trim())
    throw new AppError(ejectFailureCode(`${detail} ${stderr}`))
  }
}
