import { describe, expect, test } from 'vitest'
import { refreshSelectedBook } from '../src/renderer/src/utils/bookSelection'
import type { DisplayBook } from '../src/renderer/src/utils/mergeBooks'

function card(title: string, opts: { onDevice: boolean; libraryId?: string; path?: string }): DisplayBook {
  return {
    filename: `${title}.azw3`,
    title,
    extension: 'AZW3',
    size: 1,
    path: opts.path ?? (opts.onDevice ? `/Volumes/Kindle/documents/${title}.azw3` : ''),
    onDevice: opts.onDevice,
    ...(opts.libraryId ? { libraryId: opts.libraryId } : {})
  }
}

describe('refreshSelectedBook', () => {
  test('follows a staged book onto the device once it has been sent', () => {
    // Arrange: two staged books share the placeholder path ''.
    const staged = card('Dune', { onDevice: false, libraryId: 'lib-1' })
    const other = card('Emma', { onDevice: false, libraryId: 'lib-2' })
    const sent = card('Dune', { onDevice: true, libraryId: 'lib-1' })

    // Act
    const refreshed = refreshSelectedBook([other, sent], staged)

    // Assert
    expect(refreshed).toBe(sent)
  })

  test('never mistakes another staged book for the open one', () => {
    const open = card('Dune', { onDevice: false, libraryId: 'lib-1' })
    const other = card('Emma', { onDevice: false, libraryId: 'lib-2' })

    expect(refreshSelectedBook([other], open)).toBeNull()
  })

  test('shows a book deleted from the Kindle as library-only when the library still has it', () => {
    const open = card('Dune', { onDevice: true, libraryId: 'lib-1' })
    const libraryOnly = card('Dune', { onDevice: false, libraryId: 'lib-1' })

    expect(refreshSelectedBook([libraryOnly], open)).toBe(libraryOnly)
  })

  test('closes on a device-only book that is gone', () => {
    const open = card('Open', { onDevice: true })

    expect(refreshSelectedBook([card('Other', { onDevice: true })], open)).toBeNull()
  })
})
