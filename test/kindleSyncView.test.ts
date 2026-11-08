import { describe, expect, test } from 'vitest'
import {
  describeKindleSync,
  shouldOfferFirstSync,
  sortKindleCollections
} from '../src/renderer/src/utils/kindleSyncView'
import type { DeviceStatus, KindleSyncState } from '../src/preload/api'

const STATUS: DeviceStatus = {
  schema: 1,
  deviceId: 'kt5-ab12',
  componentVersion: '1.0.0',
  finishedAt: '2026-11-07T18:30:00Z',
  result: 'ok',
  created: 0,
  updated: 0,
  deleted: 0,
  pendingBooks: [],
  appliedDesired: null
}

function active(status: Partial<DeviceStatus>, upToDate: boolean): KindleSyncState {
  return { kind: 'active', status: { ...STATUS, ...status }, upToDate }
}

describe('describeKindleSync', () => {
  test('shows nothing while no Kindle sync state is known', () => {
    expect(describeKindleSync(null)).toBeNull()
  })

  test.each([
    ['not-jailbroken', 'kindleSync.needsJailbreak', 'https://kindlemodding.org/'],
    ['unsupported-jailbreak', 'kindleSync.unsupportedJailbreak', 'https://kindlemodding.org/'],
    ['not-installed', 'kindleSync.notInstalled', null]
  ] as const)('a %s Kindle gets an honest, muted explanation', (kind, labelKey, guideUrl) => {
    expect(describeKindleSync({ kind })).toEqual({
      tone: 'muted',
      labelKey,
      hintKey: `${labelKey}Hint`,
      hintValues: {},
      opensFirstSync: false,
      guideUrl
    })
  })

  test('the jailbreak guide is offered only while the jailbreak is what is missing', () => {
    const firstSync = describeKindleSync({ kind: 'first-sync', status: STATUS, kindleCollections: [] })

    expect(firstSync?.guideUrl).toBeNull()
    expect(describeKindleSync(active({}, true))?.guideUrl).toBeNull()
    expect(describeKindleSync(active({ result: 'error', error: 'x' }, false))?.guideUrl).toBeNull()
  })

  test('before the first-sync answer the status asks for it and opens the question', () => {
    const view = describeKindleSync({ kind: 'first-sync', status: STATUS, kindleCollections: [] })

    expect(view).toMatchObject({ tone: 'action', labelKey: 'kindleSync.firstSync', opensFirstSync: true })
  })

  test('up to date when the last run applied the current collections', () => {
    expect(describeKindleSync(active({}, true))).toMatchObject({
      tone: 'ok',
      labelKey: 'kindleSync.upToDate',
      opensFirstSync: false
    })
  })

  test('pending until the next unplug when the collections changed since the last run', () => {
    expect(describeKindleSync(active({}, false))).toMatchObject({ tone: 'pending', labelKey: 'kindleSync.pending' })
  })

  test('books the Kindle had not indexed yet are counted and retried at the next unplug', () => {
    const view = describeKindleSync(active({ result: 'partial', pendingBooks: ['A/One.azw3', 'B/Two.azw3'] }, true))

    expect(view).toMatchObject({
      tone: 'pending',
      labelKey: 'kindleSync.booksPending',
      hintValues: { count: 2 }
    })
  })

  test('a failed last run wins over everything else and carries the device message', () => {
    const view = describeKindleSync(active({ result: 'error', error: 'catalog service unavailable' }, false))

    expect(view).toMatchObject({
      tone: 'warning',
      labelKey: 'kindleSync.failed',
      hintKey: 'kindleSync.failedHint',
      hintValues: { detail: 'catalog service unavailable' }
    })
  })

  test('a failed run without a message still explains itself', () => {
    expect(describeKindleSync(active({ result: 'error' }, true))).toMatchObject({
      labelKey: 'kindleSync.failed',
      hintKey: 'kindleSync.failedNoDetailHint',
      hintValues: {}
    })
  })
})

describe('shouldOfferFirstSync', () => {
  const firstSync: KindleSyncState = { kind: 'first-sync', status: STATUS, kindleCollections: [] }

  test('offers the question once per Kindle as soon as it is due', () => {
    expect(shouldOfferFirstSync(firstSync, new Set())).toBe(true)
  })

  test('does not offer it again after the user put it off for that Kindle', () => {
    expect(shouldOfferFirstSync(firstSync, new Set(['kt5-ab12']))).toBe(false)
  })

  test('still offers it to another Kindle', () => {
    expect(shouldOfferFirstSync(firstSync, new Set(['other-kindle']))).toBe(true)
  })

  test.each([null, { kind: 'not-installed' } as const, active({}, true)])('never offers it when it is not due (%#)', (state) => {
    expect(shouldOfferFirstSync(state, new Set())).toBe(false)
  })
})

describe('sortKindleCollections', () => {
  test('lists the Kindle collections by name, ignoring case and accents, without changing the input', () => {
    const input = [
      { name: 'zibaldone', bookCount: 1 },
      { name: 'Èpica', bookCount: 2 },
      { name: 'Avventura', bookCount: 3 }
    ]

    const sorted = sortKindleCollections(input)

    expect(sorted.map((c) => c.name)).toEqual(['Avventura', 'Èpica', 'zibaldone'])
    expect(input[0].name).toBe('zibaldone')
  })
})
