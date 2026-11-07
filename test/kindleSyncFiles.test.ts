import { createHash } from 'crypto'
import { describe, expect, test } from 'vitest'
import {
  serializeDesired,
  desiredReadyMarker,
  parseDeviceExport,
  parseDeviceStatus,
  MAX_SYNC_COLLECTIONS
} from '../src/main/kindleSync/syncFiles'

describe('serializeDesired', () => {
  test('writes schema 1, the mode and each collection with its members', () => {
    // Arrange
    const plan = [{ name: 'Giallo', relpaths: ['A/One.azw3'] }]

    // Act
    const text = serializeDesired(plan, 'mirror')

    // Assert
    expect(JSON.parse(text)).toEqual({
      schema: 1,
      mode: 'mirror',
      collections: [{ name: 'Giallo', members: ['A/One.azw3'] }]
    })
  })

  test('ends with a newline and is byte-identical for the same input', () => {
    const plan = [{ name: 'Letti', relpaths: ['B.azw3'] }]

    expect(serializeDesired(plan, 'hold')).toBe(serializeDesired(plan, 'hold'))
    expect(serializeDesired(plan, 'hold').endsWith('\n')).toBe(true)
  })
})

describe('desiredReadyMarker', () => {
  test('is the sha256 of the desired text, in hex, followed by a newline', () => {
    const text = serializeDesired([], 'hold')
    const expected = createHash('sha256').update(text, 'utf8').digest('hex')

    expect(desiredReadyMarker(text)).toBe(`${expected}\n`)
  })
})

describe('parseDeviceExport', () => {
  const valid = {
    schema: 1,
    collections: [{ name: 'Letti', members: ['A/B.azw3'], otherMembers: 3 }]
  }

  test('accepts a well-formed export', () => {
    expect(parseDeviceExport(valid)).toEqual(valid)
  })

  test.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an unknown schema', { ...valid, schema: 2 }],
    ['collections not an array', { schema: 1, collections: {} }],
    ['a blank name', { schema: 1, collections: [{ name: '  ', members: [], otherMembers: 0 }] }],
    ['a non-string member', { schema: 1, collections: [{ name: 'X', members: [1], otherMembers: 0 }] }],
    ['a member outside documents/', { schema: 1, collections: [{ name: 'X', members: ['../etc/passwd'], otherMembers: 0 }] }],
    ['an absolute member', { schema: 1, collections: [{ name: 'X', members: ['/mnt/us/x.azw3'], otherMembers: 0 }] }],
    ['a negative otherMembers', { schema: 1, collections: [{ name: 'X', members: [], otherMembers: -1 }] }],
    ['a fractional otherMembers', { schema: 1, collections: [{ name: 'X', members: [], otherMembers: 1.5 }] }]
  ])('rejects %s', (_label, raw) => {
    expect(parseDeviceExport(raw)).toBeNull()
  })

  test('rejects more collections than the cap', () => {
    const collections = Array.from({ length: MAX_SYNC_COLLECTIONS + 1 }, (_, i) => ({ name: `C${i}`, members: [], otherMembers: 0 }))

    expect(parseDeviceExport({ schema: 1, collections })).toBeNull()
  })

  test('cuts an over-long name instead of keeping it whole', () => {
    const parsed = parseDeviceExport({ schema: 1, collections: [{ name: 'x'.repeat(2000), members: [], otherMembers: 0 }] })

    expect(parsed?.collections[0].name.length).toBe(512)
  })

  test('keeps only the known fields', () => {
    const parsed = parseDeviceExport({ schema: 1, extra: true, collections: [{ name: 'X', members: [], otherMembers: 0, evil: 1 }] })

    expect(parsed).toEqual({ schema: 1, collections: [{ name: 'X', members: [], otherMembers: 0 }] })
  })
})

describe('parseDeviceStatus', () => {
  const valid = {
    schema: 1,
    deviceId: 'kt5-ab12',
    componentVersion: '1.0.0',
    finishedAt: '2026-11-07T18:30:00Z',
    result: 'ok',
    created: 1,
    updated: 2,
    deleted: 0,
    pendingBooks: ['A/New.azw3'],
    appliedDesired: 'ab'.repeat(32)
  }

  test('accepts a well-formed status', () => {
    expect(parseDeviceStatus(valid)).toEqual(valid)
  })

  test('accepts a status that has applied no desired state yet', () => {
    expect(parseDeviceStatus({ ...valid, appliedDesired: null })).toEqual({ ...valid, appliedDesired: null })
  })

  test('keeps an error message, cut to a sane length', () => {
    const parsed = parseDeviceStatus({ ...valid, result: 'error', error: 'e'.repeat(5000) })

    expect(parsed?.error?.length).toBe(1000)
  })

  test.each([
    ['an unknown result', { ...valid, result: 'great' }],
    ['a device id with a path in it', { ...valid, deviceId: '../x' }],
    ['an empty device id', { ...valid, deviceId: '' }],
    ['a version that is not x.y.z', { ...valid, componentVersion: '1.0' }],
    ['a date that does not parse', { ...valid, finishedAt: 'yesterday' }],
    ['a negative count', { ...valid, created: -1 }],
    ['a pending book outside documents/', { ...valid, pendingBooks: ['../x.azw3'] }],
    ['a non-string error', { ...valid, error: 42 }],
    ['no applied desired hash', { ...valid, appliedDesired: undefined }],
    ['an applied desired hash that is not sha256 hex', { ...valid, appliedDesired: 'xyz' }]
  ])('rejects %s', (_label, raw) => {
    expect(parseDeviceStatus(raw)).toBeNull()
  })
})
