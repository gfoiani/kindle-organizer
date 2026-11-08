import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import {
  desiredHash,
  desiredReadyMarker,
  parseDeviceExport,
  parseDeviceStatus,
  serializeDesired
} from '../src/main/kindleSync/syncFiles'

// Shared with the on-device component's internal/contract/fixtures_test.go:
// desired.* as this app writes them, status/export as the component writes them.
const FIXTURES = path.join(__dirname, '..', 'component', 'testdata', 'contract')

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf-8')
}

describe('the file contract with the on-device component', () => {
  test('desired.json and desired.ready are written exactly as the component expects them', () => {
    const text = serializeDesired(
      [
        { name: 'Giallo', relpaths: ['Gialli/Uno.azw3', 'Città/Due.pdf'] },
        { name: 'Vuota', relpaths: [] }
      ],
      'mirror'
    )

    expect(text).toBe(fixture('desired.json'))
    expect(desiredReadyMarker(text)).toBe(fixture('desired.ready'))
  })

  test('the status.json the component writes is accepted whole', () => {
    const status = parseDeviceStatus(JSON.parse(fixture('status.json')))

    expect(status).toEqual({
      schema: 1,
      deviceId: 'kt5-ab12',
      componentVersion: '0.1.0',
      finishedAt: '2026-11-08T09:00:00Z',
      result: 'partial',
      created: 1,
      updated: 2,
      deleted: 0,
      pendingBooks: ['Nuovo.azw3'],
      appliedDesired: desiredHash(fixture('desired.json'))
    })
  })

  test('the export.json the component writes is accepted whole', () => {
    expect(parseDeviceExport(JSON.parse(fixture('export.json')))).toEqual({
      schema: 1,
      collections: [{ name: 'Giallo', members: ['Gialli/Uno.azw3'], otherMembers: 2 }]
    })
  })
})
