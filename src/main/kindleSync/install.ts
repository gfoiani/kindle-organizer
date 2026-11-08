import { promises as fs } from 'fs'
import path from 'path'
import { AppError } from '../appErrors'
import { writeFileAtomically } from '../atomicWrite'
import { capLength } from '../textLimits'
import { SYNC_DIR } from './deviceFiles'

/**
 * Installing the on-device component (component/ in this repo, `kosync`) on a
 * jb.sh Kindle. The app copies the binary to the USB partition and writes an
 * installer as `/mnt/us/emergency.sh`, which jb.sh runs once, as root, at the
 * next boot. The installer deletes itself first — a leftover emergency.sh would
 * run at every boot and make jb.sh skip its own repairs — and carries on from a
 * copy in /tmp, then copies the component to the device's flash and registers
 * an upstart job for it.
 */

/** Marks an emergency.sh as the app's own, the only kind it may replace. */
export const INSTALLER_MARKER = '# kindle-organizer installer'

const EMERGENCY_FILE = 'emergency.sh'
const COMPONENT_DIR = 'component'
const COMPONENT_FILE = 'kosync'
const INSTALL_LOG = 'install.log'
/** The component is ~6 MB; anything far larger is not it. */
const MAX_BINARY_BYTES = 64 * 1024 * 1024
/** emergency.sh and install.log are small; only their start or tail is ever needed. */
const MAX_TEXT_BYTES = 64 * 1024
const MAX_DETAIL = 300

const INSTALLER = `#!/bin/sh
${INSTALLER_MARKER}
SELF=/mnt/us/emergency.sh
RUN=/tmp/kindle-organizer-installer.sh
if [ "$0" != "$RUN" ]; then
  cp "$SELF" "$RUN"
  rm -f "$SELF"
  sync
  [ -f "$RUN" ] || exit 1
  exec /bin/sh "$RUN"
fi

# Installs Kindle Organizer's collection sync. The app writes this file as
# /mnt/us/emergency.sh; jb.sh runs it once, as root, at the next boot. The
# bootstrap above deletes it first, so it never runs again, and carries on from
# a copy in /tmp: busybox sh reads a script while running it, and nothing after
# deleting the file it is reading would run (seen on a KT5). An if-block is
# parsed whole before it runs, so the bootstrap runs from memory. What happened
# is logged to kindle-organizer/install.log.

SOURCE=/mnt/us/kindle-organizer/component/kosync
HOME_DIR=/var/local/kindle-organizer
JOB=/etc/upstart/kindle-organizer.conf
LOG=/mnt/us/kindle-organizer/install.log

fail() {
  echo "FAILED: $1"
  exit 1
}

write_job() {
  cat > "$JOB" <<'UPSTART'
# Kindle Organizer collection sync, installed by the Kindle Organizer app.
start on framework_ready
respawn
respawn limit 5 300
exec /var/local/kindle-organizer/kosync watch
UPSTART
}

install_sync() {
  [ -f "$SOURCE" ] || fail "the component is missing from kindle-organizer/component"
  mkdir -p "$HOME_DIR" || fail "cannot create $HOME_DIR"
  cp "$SOURCE" "$HOME_DIR/kosync.new" || fail "cannot copy the component"
  chmod 755 "$HOME_DIR/kosync.new" || fail "cannot make the component executable"
  "$HOME_DIR/kosync.new" version || fail "the component does not run on this Kindle"
  stop kindle-organizer >/dev/null 2>&1
  mv -f "$HOME_DIR/kosync.new" "$HOME_DIR/kosync" || fail "cannot put the component in place"
  mntroot rw || fail "cannot make the system partition writable"
  write_job
  written=$?
  mntroot ro
  [ "$written" -eq 0 ] || fail "cannot write $JOB"
  start kindle-organizer || fail "cannot start the sync"
  echo "OK"
}

mkdir -p /mnt/us/kindle-organizer
# A subshell, so fail()'s exit ends the install, not the cleanup below.
( install_sync ) > "$LOG" 2>&1
status=$?
rm -f "$RUN"
exit $status
`

export function installerScript(): string {
  return INSTALLER
}

export interface AppLocation {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

/** Where the ARM build of the component is: bundled with the app, or the dev build (`yarn build:component`). */
export function componentBinaryPath(location: AppLocation): string {
  return location.isPackaged
    ? path.join(location.resourcesPath, 'kindle-sync', 'kosync')
    : path.join(location.appPath, 'component', 'dist', 'kosync-linux-armv7')
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readBinary(binaryPath: string): Promise<Buffer> {
  try {
    const stat = await fs.stat(binaryPath)
    if (!stat.isFile() || stat.size > MAX_BINARY_BYTES) throw new AppError('KINDLE_SYNC_COMPONENT_MISSING')
    return await fs.readFile(binaryPath)
  } catch (err) {
    if (isMissing(err)) throw new AppError('KINDLE_SYNC_COMPONENT_MISSING')
    throw err
  }
}

/**
 * The last MAX_TEXT_BYTES of a plain file, undefined when there is none. A
 * link or folder in its place counts as present but unreadable ('').
 */
async function readTail(file: string): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile()) return ''
    handle = await fs.open(file, 'r')
    const length = Math.min(stat.size, MAX_TEXT_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    return buffer.toString('utf8')
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  } finally {
    await handle?.close()
  }
}

async function readEmergency(mountpoint: string): Promise<string | undefined> {
  return readTail(path.join(mountpoint, EMERGENCY_FILE))
}

/**
 * Puts the component and its installer on the Kindle; the install completes at
 * the next restart. An emergency.sh that is not the app's is never replaced.
 * The installer is written last: until it exists the device does nothing.
 */
export async function stageInstall(mountpoint: string, binaryPath: string): Promise<void> {
  const binary = await readBinary(binaryPath)
  const existing = await readEmergency(mountpoint)
  if (existing !== undefined && !existing.includes(INSTALLER_MARKER)) throw new AppError('KINDLE_SYNC_EMERGENCY_IN_USE')

  const dir = path.join(mountpoint, SYNC_DIR, COMPONENT_DIR)
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomically(path.join(dir, COMPONENT_FILE), binary)
  await writeFileAtomically(path.join(mountpoint, EMERGENCY_FILE), INSTALLER)
}

export type InstallProgress = { kind: 'none' } | { kind: 'pending' } | { kind: 'failed'; detail: string }

/**
 * How an install stands on a Kindle whose component has not reported yet:
 * waiting for the restart while the app's installer is there, failed when its
 * log (device-written, so capped) ends with a FAILED line.
 */
export async function readInstallProgress(mountpoint: string): Promise<InstallProgress> {
  const emergency = await readEmergency(mountpoint)
  if (emergency?.includes(INSTALLER_MARKER)) return { kind: 'pending' }

  const log = await readTail(path.join(mountpoint, SYNC_DIR, INSTALL_LOG))
  const lastLine = log?.trimEnd().split('\n').pop() ?? ''
  if (lastLine.startsWith('FAILED:')) {
    return { kind: 'failed', detail: capLength(lastLine.slice('FAILED:'.length).trim(), MAX_DETAIL) }
  }
  return { kind: 'none' }
}
