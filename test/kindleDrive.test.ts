import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('systeminformation', () => ({ default: { blockDevices: vi.fn() } }))

import si from 'systeminformation'
import { requireKindleDrive, KINDLE_VERIFY_TTL_MS } from '../src/main/kindle'

type BlockDevice = Awaited<ReturnType<typeof si.blockDevices>>[number]

const blockDevices = vi.mocked(si.blockDevices)

function kindleAt(mount: string): BlockDevice {
  return { name: 'disk4', mount, label: 'Kindle', model: '', size: 1 } as BlockDevice
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
    // Arrange: verified at t=0, then the Kindle is unplugged.
    blockDevices.mockResolvedValueOnce([kindleAt('/Volumes/Kindle-C')]).mockResolvedValue([])
    await requireKindleDrive('/Volumes/Kindle-C', 0)

    // Act + Assert: a bulk send within the window does not re-run detection...
    await expect(requireKindleDrive('/Volumes/Kindle-C', 1000)).resolves.toMatchObject({
      mountpoint: '/Volumes/Kindle-C'
    })
    expect(blockDevices).toHaveBeenCalledTimes(1)

    // ...but past it, the unplugged drive is refused.
    await expect(requireKindleDrive('/Volumes/Kindle-C', KINDLE_VERIFY_TTL_MS + 1)).rejects.toThrow(
      'DEVICE_NOT_FOUND'
    )
  })
})
