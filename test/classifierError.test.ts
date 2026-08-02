import { describe, expect, test } from 'vitest'
import en from '../src/renderer/locales/en.json'
import it from '../src/renderer/locales/it.json'
import {
  CLASSIFIER_ERROR_CODES,
  classifierErrorKey
} from '../src/renderer/src/utils/classifierError'

/** Resolves a dotted i18n key against a locale bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      bundle
    )
}

describe('classifierErrorKey', () => {
  test('gives a missing model its own message, distinct from the engine failure', () => {
    // Arrange / Act
    const missing = classifierErrorKey('MODEL_MISSING')
    const engine = classifierErrorKey('WORKER_INIT_FAILED')

    // Assert — the whole point: "model not downloaded" must not read as
    // "could not start the classification engine".
    expect(missing).not.toBe(engine)
    expect(lookup(en, missing)).not.toBe(lookup(en, engine))
  })

  test('distinguishes a missing model from a failed download and a failed load', () => {
    const keys = [
      classifierErrorKey('MODEL_MISSING'),
      classifierErrorKey('MODEL_DOWNLOAD_FAILED'),
      classifierErrorKey('MODEL_LOAD_FAILED')
    ]

    expect(new Set(keys).size).toBe(keys.length)
  })

  test('maps a label-count failure to the categories hint', () => {
    expect(classifierErrorKey('NEED_TWO_LABELS')).toBe('aiClassify.needMoreLabels')
  })

  test('every code resolves to a non-empty string in both locales', () => {
    for (const code of CLASSIFIER_ERROR_CODES) {
      const key = classifierErrorKey(code)

      for (const [name, bundle] of [
        ['en', en],
        ['it', it]
      ] as const) {
        const message = lookup(bundle, key)
        expect(typeof message, `${name}: ${key} (${code})`).toBe('string')
        expect((message as string).length, `${name}: ${key} (${code})`).toBeGreaterThan(0)
      }
    }
  })
})
