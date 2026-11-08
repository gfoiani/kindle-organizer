import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  INSTALLER_MARKER,
  componentBinaryPath,
  installerScript,
  readInstallProgress,
  stageInstall
} from '../src/main/kindleSync/install'

let mountpoint: string
let binary: string

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'install-kindle-'))
  binary = path.join(mkdtempSync(path.join(tmpdir(), 'install-binary-')), 'kosync')
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]))
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
  rmSync(path.dirname(binary), { recursive: true, force: true })
})

const emergency = (): string => path.join(mountpoint, 'emergency.sh')
const stagedBinary = (): string => path.join(mountpoint, 'kindle-organizer', 'component', 'kosync')

/** The script's commands, without comments and blank lines. */
function commands(script: string): string[] {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** The installer as it runs from a Kindle, with its device paths moved under `root`. */
function sandboxedInstaller(root: string): string {
  return installerScript()
    .replaceAll('/mnt/us/', `${root}/us/`)
    .replaceAll('/tmp/kindle-organizer-installer.sh', `${root}/installer-copy.sh`)
    .replaceAll('/var/local/kindle-organizer', `${root}/var-local`)
    .replaceAll('/etc/upstart/', `${root}/upstart/`)
}

describe('installerScript', () => {
  test('starts with one bootstrap block that copies it to /tmp and deletes the original before anything else', () => {
    // busybox sh reads a script while running it: on a KT5 nothing after
    // deleting /mnt/us/emergency.sh ran. An if-block is parsed whole before it
    // runs, so the copy, the delete and the hand-off all happen from memory.
    const lines = commands(installerScript())
    const blockStart = lines.findIndex((line) => line.startsWith('if '))
    const blockEnd = lines.indexOf('fi')
    const beforeBlock = lines.slice(0, blockStart)
    const block = lines.slice(blockStart, blockEnd + 1)

    expect(beforeBlock.every((line) => /^[A-Z_]+=\S+$/.test(line))).toBe(true)
    expect(block[0]).toBe('if [ "$0" != "$RUN" ]; then')
    expect(block).toContain('cp "$SELF" "$RUN"')
    expect(block).toContain('rm -f "$SELF"')
    expect(block.indexOf('cp "$SELF" "$RUN"')).toBeLessThan(block.indexOf('rm -f "$SELF"'))
    expect(block).toContain('exec /bin/sh "$RUN"')
    expect(lines).toContain('SELF=/mnt/us/emergency.sh')
    expect(lines).toContain('RUN=/tmp/kindle-organizer-installer.sh')
  })

  test('run as jb.sh runs it, it deletes emergency.sh, carries on from the copy, and logs the outcome', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'installer-run-'))
    try {
      mkdirSync(path.join(root, 'us'))
      const self = path.join(root, 'us', 'emergency.sh')
      writeFileSync(self, sandboxedInstaller(root))

      const run = spawnSync('/bin/sh', [self], { cwd: root, encoding: 'utf8' })

      expect(run.status).toBe(1)
      expect(existsSync(self)).toBe(false)
      expect(existsSync(path.join(root, 'installer-copy.sh'))).toBe(false)
      // No component was staged: the copy reached the install and stopped at its first check.
      expect(readFileSync(path.join(root, 'us', 'kindle-organizer', 'install.log'), 'utf8')).toBe(
        'FAILED: the component is missing from kindle-organizer/component\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('is a valid shell script carrying the app’s marker', () => {
    const script = installerScript()

    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(INSTALLER_MARKER)
    expect(spawnSync('sh', ['-n'], { input: script }).status).toBe(0)
  })

  test('installs the component and an upstart job that runs it after the framework is up', () => {
    const script = installerScript()

    expect(script).toContain('/mnt/us/kindle-organizer/component/kosync')
    expect(script).toContain('/var/local/kindle-organizer')
    expect(script).toContain('/etc/upstart/kindle-organizer.conf')
    expect(script).toContain('start on framework_ready')
    expect(script).toContain('exec /var/local/kindle-organizer/kosync watch')
    expect(script).toMatch(/respawn limit \d+ \d+/)
  })

  test('checks the component runs on this Kindle before putting it in place, and puts the system partition back read-only', () => {
    const script = installerScript()

    expect(script.indexOf('kosync.new" version')).toBeGreaterThan(-1)
    expect(script.indexOf('kosync.new" version')).toBeLessThan(script.indexOf('mv -f'))
    expect(script).toContain('mntroot rw')
    expect(script).toContain('mntroot ro')
  })

  test('reports how it went in install.log: OK, or FAILED with the step', () => {
    const script = installerScript()

    expect(script).toContain('/mnt/us/kindle-organizer/install.log')
    expect(script).toContain('echo "OK"')
    expect(script).toContain('echo "FAILED: $1"')
  })
})

describe('componentBinaryPath', () => {
  test('ships inside the packaged app', () => {
    expect(componentBinaryPath({ isPackaged: true, resourcesPath: '/R', appPath: '/A' })).toBe(path.join('/R', 'kindle-sync', 'kosync'))
  })

  test('comes from the component build in development', () => {
    expect(componentBinaryPath({ isPackaged: false, resourcesPath: '/R', appPath: '/A' })).toBe(
      path.join('/A', 'component', 'dist', 'kosync-linux-armv7')
    )
  })
})

describe('stageInstall', () => {
  test('copies the component and writes the installer as emergency.sh', async () => {
    await stageInstall(mountpoint, binary)

    expect(readFileSync(stagedBinary())).toEqual(readFileSync(binary))
    expect(readFileSync(emergency(), 'utf8')).toBe(installerScript())
    expect(readdirSync(mountpoint).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('never replaces an emergency.sh that is not the app’s', async () => {
    writeFileSync(emergency(), '#!/bin/sh\n# another tool\n')

    await expect(stageInstall(mountpoint, binary)).rejects.toThrow('KINDLE_SYNC_EMERGENCY_IN_USE')
    expect(readFileSync(emergency(), 'utf8')).toBe('#!/bin/sh\n# another tool\n')
    expect(existsSync(stagedBinary())).toBe(false)
  })

  test('replaces its own installer still waiting for a restart', async () => {
    await stageInstall(mountpoint, binary)

    await expect(stageInstall(mountpoint, binary)).resolves.toBeUndefined()
  })

  test('writes nothing to the Kindle when the component is not bundled', async () => {
    await expect(stageInstall(mountpoint, path.join(mountpoint, 'absent'))).rejects.toThrow('KINDLE_SYNC_COMPONENT_MISSING')
    expect(existsSync(emergency())).toBe(false)
    expect(existsSync(path.join(mountpoint, 'kindle-organizer'))).toBe(false)
  })
})

describe('readInstallProgress', () => {
  function writeLog(content: string): void {
    mkdirSync(path.join(mountpoint, 'kindle-organizer'), { recursive: true })
    writeFileSync(path.join(mountpoint, 'kindle-organizer', 'install.log'), content)
  }

  test('nothing staged, nothing logged', async () => {
    expect(await readInstallProgress(mountpoint)).toEqual({ kind: 'none' })
  })

  test('pending while the installer waits for the restart, even over an old failure', async () => {
    writeLog('FAILED: old\n')
    await stageInstall(mountpoint, binary)

    expect(await readInstallProgress(mountpoint)).toEqual({ kind: 'pending' })
  })

  test('failed with the installer’s own reason', async () => {
    writeLog('x\nFAILED: the component does not run on this Kindle\n')

    expect(await readInstallProgress(mountpoint)).toEqual({ kind: 'failed', detail: 'the component does not run on this Kindle' })
  })

  test('a foreign emergency.sh is not the app’s install in progress', async () => {
    writeFileSync(emergency(), '#!/bin/sh\n')

    expect(await readInstallProgress(mountpoint)).toEqual({ kind: 'none' })
  })
})
