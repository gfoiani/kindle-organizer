import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('systeminformation', () => ({ default: { blockDevices: vi.fn() } }))

import si from 'systeminformation'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { requireKindleDrive, KINDLE_VERIFY_TTL_MS } from '../src/main/kindle'

type BlockDevice = Awaited<ReturnType<typeof si.blockDevices>>[number]

const blockDevices = vi.mocked(si.blockDevices)

function kindleAt(mount: string): BlockDevice {
  return { name: 'disk4', mount, label: 'Kindle', model: '', size: 1 } as BlockDevice
}

/** A temp directory standing for a mounted Kindle volume (it has documents/). */
function mountedVolume(): string {
  const mount = mkdtempSync(path.join(tmpdir(), 'kindle-volume-'))
  mkdirSync(path.join(mount, 'documents'))
  return mount
}

describe('requireKindleDrive', () => {
  beforeEach(() => {
    blockDevices.mockReset()
  })

  test('resolves the drive a live detection reports at that mountpoint', async () => {
    // Arrange
    blockDevices.mockResolvedValue([kindleAt('/Volumes/Kindle-A')])

    // Act
    const drive = await requireKindleDrive('/Volumes/Kindle-A', 0)

    // Assert
    expect(drive.mountpoint).toBe('/Volumes/Kindle-A')
  })

  test('refuses a path that is not a detected Kindle', async () => {
    blockDevices.mockResolvedValue([kindleAt('/Volumes/Kindle-B')])

    await expect(requireKindleDrive('/Users/someone', 0)).rejects.toThrow('DEVICE_NOT_FOUND')
  })

  test('reuses a recent detection, then detects again once it is stale', async () => {
    // Arrange: verified at t=0 (the volume is still mounted), then detection stops reporting it.
    const mount = mountedVolume()
    blockDevices.mockResolvedValueOnce([kindleAt(mount)]).mockResolvedValue([])
    await requireKindleDrive(mount, 0)

    // Act + Assert: a bulk send within the window does not re-run detection...
    await expect(requireKindleDrive(mount, 1000)).resolves.toMatchObject({ mountpoint: mount })
    expect(blockDevices).toHaveBeenCalledTimes(1)

    // ...but past it, a drive detection no longer reports is refused.
    await expect(requireKindleDrive(mount, KINDLE_VERIFY_TTL_MS + 1)).rejects.toThrow('DEVICE_NOT_FOUND')
  })

  test('refuses a recently verified Kindle whose volume has since been unplugged', async () => {
    // Arrange
    const mount = mountedVolume()
    blockDevices.mockResolvedValueOnce([kindleAt(mount)]).mockResolvedValue([])
    await requireKindleDrive(mount, 0)

    // Act: unplugged a second later — its documents/ folder is gone.
    rmSync(mount, { recursive: true, force: true })

    // Assert
    await expect(requireKindleDrive(mount, 1000)).rejects.toThrow('DEVICE_NOT_FOUND')
  })
})
