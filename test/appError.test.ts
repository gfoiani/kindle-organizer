import { describe, expect, test } from 'vitest'
import { errorMessageKey } from '../src/renderer/src/utils/appError'

const FALLBACK = 'errors.createCollection'

describe('errorMessageKey', () => {
  test('maps a bare AppError message to its i18n key', () => {
    // Arrange / Act
    const key = errorMessageKey(new Error('COLLECTION_NAME_TAKEN'), FALLBACK)

    // Assert
    expect(key).toBe('errors.collectionNameTaken')
  })

  test('finds the code inside the wrapper Electron adds around a rejection', () => {
    // Arrange — the exact shape ipcRenderer.invoke rejects with: the handler's
    // message is embedded in, not equal to, the error the renderer receives.
    const wrapped = new Error(
      "Error invoking remote method 'kindle:create-collection': Error: COLLECTION_NAME_TAKEN"
    )

    // Act / Assert
    expect(errorMessageKey(wrapped, FALLBACK)).toBe('errors.collectionNameTaken')
  })

  test('maps every declared code, not just the first', () => {
    expect(errorMessageKey(new Error('COLLECTION_NAME_EMPTY'), FALLBACK)).toBe(
      'errors.collectionNameEmpty'
    )
  })

  test('falls back to the per-operation key for an unrecognized failure', () => {
    const sqlite = new Error('SQLITE_IOERR: disk I/O error')
    expect(errorMessageKey(sqlite, FALLBACK)).toBe(FALLBACK)
  })

  test('handles a non-Error rejection value', () => {
    expect(errorMessageKey('COLLECTION_NAME_TAKEN', FALLBACK)).toBe('errors.collectionNameTaken')
    expect(errorMessageKey(undefined, FALLBACK)).toBe(FALLBACK)
  })
})
