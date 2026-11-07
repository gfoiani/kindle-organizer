import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { readDeviceExportFile, readDeviceStatusFile, writeDesiredState, SYNC_DIR } from '../src/main/kindleSync/deviceFiles'
import { desiredReadyMarker } from '../src/main/kindleSync/syncFiles'

let mountpoint: string
const syncDir = (): string => path.join(mountpoint, SYNC_DIR)

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
})

const status = {
  schema: 1,
  deviceId: 'kt5-ab12',
  componentVersion: '1.0.0',
  finishedAt: '2026-11-07T18:30:00Z',
  result: 'ok',
  created: 0,
  updated: 1,
  deleted: 0,
  pendingBooks: [],
  appliedDesired: null
}

describe('writeDesiredState', () => {
  test('creates the folder and writes desired.json with a matching ready marker', async () => {
    // Act
    const outcome = await writeDesiredState(mountpoint, [{ name: 'Giallo', relpaths: ['A/One.azw3'] }], 'hold')

    // Assert
    const desired = readFileSync(path.join(syncDir(), 'desired.json'), 'utf8')
    expect(outcome).toBe('written')
    expect(JSON.parse(desired).collections).toEqual([{ name: 'Giallo', members: ['A/One.azw3'] }])
    expect(readFileSync(path.join(syncDir(), 'desired.ready'), 'utf8')).toBe(desiredReadyMarker(desired))
  })

  test('leaves no temp files behind', async () => {
    await writeDesiredState(mountpoint, [], 'hold')

    expect(readdirSync(syncDir()).sort()).toEqual(['desired.json', 'desired.ready'])
  })

  test('does not rewrite identical state (no needless writes to the device)', async () => {
    const plan = [{ name: 'Letti', relpaths: ['B.azw3'] }]
    await writeDesiredState(mountpoint, plan, 'mirror')
    const before = statSync(path.join(syncDir(), 'desired.json')).mtimeMs

    const outcome = await writeDesiredState(mountpoint, plan, 'mirror')

    expect(outcome).toBe('unchanged')
    expect(statSync(path.join(syncDir(), 'desired.json')).mtimeMs).toBe(before)
  })

  test('rewrites when the ready marker does not match (an interrupted earlier write)', async () => {
    const plan = [{ name: 'Letti', relpaths: ['B.azw3'] }]
    await writeDesiredState(mountpoint, plan, 'mirror')
    writeFileSync(path.join(syncDir(), 'desired.ready'), 'stale\n')

    expect(await writeDesiredState(mountpoint, plan, 'mirror')).toBe('written')
  })

  test('refuses a sync folder that is a link', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'elsewhere-'))
    symlinkSync(elsewhere, syncDir())

    await expect(writeDesiredState(mountpoint, [], 'hold')).rejects.toThrow()
    expect(existsSync(path.join(elsewhere, 'desired.json'))).toBe(false)
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe('readDeviceStatusFile', () => {
  test('is null when the component never ran', async () => {
    expect(await readDeviceStatusFile(mountpoint)).toBeNull()
  })

  test('returns the validated status', async () => {
    mkdirSync(syncDir())
    writeFileSync(path.join(syncDir(), 'status.json'), JSON.stringify(status))

    expect(await readDeviceStatusFile(mountpoint)).toEqual(status)
  })

  test('is null for a file that is not JSON', async () => {
    mkdirSync(syncDir())
    writeFileSync(path.join(syncDir(), 'status.json'), '{not json')

    expect(await readDeviceStatusFile(mountpoint)).toBeNull()
  })

  test('is null for a file that fails validation', async () => {
    mkdirSync(syncDir())
    writeFileSync(path.join(syncDir(), 'status.json'), JSON.stringify({ ...status, result: 'great' }))

    expect(await readDeviceStatusFile(mountpoint)).toBeNull()
  })

  test('does not read an oversized file', async () => {
    mkdirSync(syncDir())
    writeFileSync(path.join(syncDir(), 'status.json'), JSON.stringify({ ...status, pad: 'x'.repeat(17 * 1024 * 1024) }))

    expect(await readDeviceStatusFile(mountpoint)).toBeNull()
  })

  test('does not follow a link', async () => {
    mkdirSync(syncDir())
    const elsewhere = path.join(mountpoint, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify(status))
    symlinkSync(elsewhere, path.join(syncDir(), 'status.json'))

    expect(await readDeviceStatusFile(mountpoint)).toBeNull()
  })
})

describe('readDeviceExportFile', () => {
  test('returns the validated export', async () => {
    const exported = { schema: 1, collections: [{ name: 'Letti', members: ['A/B.azw3'], otherMembers: 2 }] }
    mkdirSync(syncDir())
    writeFileSync(path.join(syncDir(), 'export.json'), JSON.stringify(exported))

    expect(await readDeviceExportFile(mountpoint)).toEqual(exported)
  })
})
