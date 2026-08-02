import { describe, expect, test } from 'vitest'
import {
  bookKey,
  collectableBooks,
  removableBooks,
  selectedBooks,
  sendableBooks
} from '../src/renderer/src/utils/bulkSelection'
import type { DisplayBook } from '../src/renderer/src/utils/mergeBooks'

function make(title: string, opts: { onDevice: boolean; libraryId?: string }): DisplayBook {
  return {
    filename: `${title}.azw3`,
    title,
    extension: 'AZW3',
    size: 1024,
    path: opts.onDevice ? `/Volumes/Kindle/documents/${title}.azw3` : '',
    onDevice: opts.onDevice,
    ...(opts.libraryId ? { libraryId: opts.libraryId } : {})
  }
}

// The three states a card can be in.
const STAGED = make('Troppo comodi', { onDevice: false, libraryId: 'lib-1' })
const SENT = make('Dune', { onDevice: true, libraryId: 'lib-2' })
const DEVICE_ONLY = make('Open', { onDevice: true })
const ALL = [STAGED, SENT, DEVICE_ONLY]

describe('bookKey', () => {
  test('prefers the library id, so a card keeps its identity once sent', () => {
    // Same book before and after it lands on the device.
    expect(bookKey(STAGED)).toBe('lib-1')
    expect(bookKey(make('Troppo comodi', { onDevice: true, libraryId: 'lib-1' }))).toBe('lib-1')
  })

  test('falls back to the device path for a book with no library entry', () => {
    expect(bookKey(DEVICE_ONLY)).toBe('/Volumes/Kindle/documents/Open.azw3')
  })
})

describe('selectedBooks', () => {
  test('returns the selected books in list order', () => {
    const result = selectedBooks(ALL, new Set(['/Volumes/Kindle/documents/Open.azw3', 'lib-1']))
    expect(result.map((b) => b.title)).toEqual(['Troppo comodi', 'Open'])
  })

  test('ignores keys that match nothing (e.g. a book removed since selection)', () => {
    expect(selectedBooks(ALL, new Set(['gone']))).toEqual([])
  })

  test('an empty selection selects nothing', () => {
    expect(selectedBooks(ALL, new Set())).toEqual([])
  })
})

describe('sendableBooks', () => {
  test('only staged books that have not reached the device', () => {
    expect(sendableBooks(ALL).map((b) => b.title)).toEqual(['Troppo comodi'])
  })

  test('excludes an already-sent book — there is nothing left to upload', () => {
    expect(sendableBooks([SENT])).toEqual([])
  })

  test('excludes a device-only book — it has no library copy to convert', () => {
    expect(sendableBooks([DEVICE_ONLY])).toEqual([])
  })
})

describe('removableBooks', () => {
  test('includes a sent book: removing the staged copy leaves the device file', () => {
    expect(removableBooks(ALL).map((b) => b.title)).toEqual(['Troppo comodi', 'Dune'])
  })

  test('excludes a device-only book — it has no library entry to delete', () => {
    expect(removableBooks([DEVICE_ONLY])).toEqual([])
  })
})

describe('collectableBooks', () => {
  test('only books on the device, since collections are device tags', () => {
    expect(collectableBooks(ALL).map((b) => b.title)).toEqual(['Dune', 'Open'])
  })

  test('excludes a staged book that never reached the device', () => {
    expect(collectableBooks([STAGED])).toEqual([])
  })
})

describe('eligibility partitions', () => {
  test('send and collect are mutually exclusive — no book qualifies for both', () => {
    const sendable = new Set(sendableBooks(ALL).map(bookKey))
    const collectable = collectableBooks(ALL).map(bookKey)
    expect(collectable.some((key) => sendable.has(key))).toBe(false)
  })
})
