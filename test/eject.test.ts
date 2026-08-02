import { describe, expect, test } from 'vitest'
import { ejectCommand, ejectFailureCode } from '../src/main/eject'
import type { KindleDrive } from '../src/main/kindle'

function drive(mountpoint: string): KindleDrive {
  return {
    device: 'disk4s1',
    mountpoint,
    description: 'Kindle',
    size: 8_000_000_000,
    isReadOnly: false
  }
}

describe('ejectCommand', () => {
  test('ejects by mount point through diskutil on macOS', () => {
    // Arrange / Act
    const { command, args } = ejectCommand('darwin', drive('/Volumes/Kindle'))

    // Assert
    expect(command).toBe('diskutil')
    expect(args).toEqual(['eject', '/Volumes/Kindle'])
  })

  test('uses the shell eject verb on Windows', () => {
    const { command, args } = ejectCommand('win32', drive('E:\\'))

    expect(command).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args[3]).toContain("ParseName('E:')")
    expect(args[3]).toContain("InvokeVerb('Eject')")
  })

  test('accepts a Windows drive letter with or without a trailing separator', () => {
    expect(ejectCommand('win32', drive('E:')).args[3]).toContain("ParseName('E:')")
    expect(ejectCommand('win32', drive('e:\\')).args[3]).toContain("ParseName('e:')")
  })

  test('refuses a Windows path that is not a bare drive letter', () => {
    // Arrange — the PowerShell command is a string, so anything that could carry
    // a quote or a statement separator into it must be rejected outright.
    for (const hostile of [
      "E:'); Remove-Item C:\\ -Recurse; ('",
      '\\\\server\\share',
      'E:\\documents',
      ''
    ]) {
      expect(() => ejectCommand('win32', drive(hostile))).toThrow('EJECT_FAILED')
    }
  })

  test('falls back to eject(1) on other platforms', () => {
    const { command, args } = ejectCommand('linux', drive('/media/gfoiani/Kindle'))

    expect(command).toBe('eject')
    expect(args).toEqual(['/media/gfoiani/Kindle'])
  })

  test('never builds a shell string on the unix paths', () => {
    // A mount point with shell metacharacters is safe because it travels as a
    // single argv entry — this pins that contract.
    const hostile = '/Volumes/Kindle; rm -rf ~'
    expect(ejectCommand('darwin', drive(hostile)).args).toEqual(['eject', hostile])
    expect(ejectCommand('linux', drive(hostile)).args).toEqual([hostile])
  })
})

describe('ejectFailureCode', () => {
  test('recognizes a volume the system says is still in use', () => {
    // Arrange — what diskutil actually prints when a process holds the volume.
    const dissenter =
      'Unmount of disk3 failed: at least one volume could not be unmounted (dissenter PID=421 (mds_stores))'

    // Act / Assert
    expect(ejectFailureCode(dissenter)).toBe('EJECT_BUSY')
  })

  test('recognizes the busy wording of the other platforms', () => {
    expect(ejectFailureCode('eject: unable to eject, last error: Resource busy')).toBe('EJECT_BUSY')
    expect(ejectFailureCode('The disc is in use by another application.')).toBe('EJECT_BUSY')
  })

  test('keeps anything else generic instead of blaming open files', () => {
    // The failure that actually happened: the app called a channel its running
    // main process did not have, which has nothing to do with a busy volume.
    expect(ejectFailureCode("No handler registered for 'kindle:eject'")).toBe('EJECT_FAILED')
    expect(ejectFailureCode('spawn diskutil ENOENT')).toBe('EJECT_FAILED')
    expect(ejectFailureCode('')).toBe('EJECT_FAILED')
  })
})
