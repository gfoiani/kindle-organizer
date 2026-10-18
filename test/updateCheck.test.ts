import { describe, expect, test } from 'vitest'
import { checkForUpdate, isNewerVersion } from '../src/main/updateCheck'

const RELEASE_URL = 'https://github.com/gfoiani/kindle-organizer/releases/tag/v0.5.0'

describe('isNewerVersion', () => {
  test.each([
    ['0.5.0', '0.4.0', true],
    ['v0.4.1', '0.4.0', true],
    ['0.10.0', '0.9.0', true],
    ['1.0.0', '0.99.99', true],
    ['0.4.0', '0.4.0', false],
    ['0.3.9', '0.4.0', false],
    ['0.5.0-beta.1', '0.4.0', false],
    ['garbage', '0.4.0', false]
  ])('%s over %s → %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })
})

describe('checkForUpdate', () => {
  test('reports a newer release with its page', async () => {
    const update = await checkForUpdate('0.4.0', async () => ({ tag_name: 'v0.5.0', html_url: RELEASE_URL }))

    expect(update).toEqual({ version: '0.5.0', url: RELEASE_URL })
  })

  test('is null when the running version is current', async () => {
    expect(await checkForUpdate('0.5.0', async () => ({ tag_name: 'v0.5.0', html_url: RELEASE_URL }))).toBeNull()
  })

  test('ignores a release page outside the project repository', async () => {
    const update = await checkForUpdate('0.4.0', async () => ({ tag_name: 'v0.5.0', html_url: 'https://evil.example/x' }))

    expect(update).toBeNull()
  })

  test('is null, never an error, when the check cannot complete', async () => {
    expect(
      await checkForUpdate('0.4.0', async () => {
        throw new Error('offline')
      })
    ).toBeNull()
    expect(await checkForUpdate('0.4.0', async () => null)).toBeNull()
    expect(await checkForUpdate('0.4.0', async () => ({ tag_name: 5 }))).toBeNull()
  })
})
