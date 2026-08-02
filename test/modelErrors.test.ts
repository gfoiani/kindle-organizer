import { describe, expect, test } from 'vitest'
import { modelErrorCode } from '../src/renderer/src/workers/modelErrors'

describe('modelErrorCode', () => {
  test('reports a missing model when the model files cannot be located', () => {
    // Arrange — the exact shape transformers.js throws for a 404 (see
    // node_modules/@xenova/transformers/src/utils/hub.js ERROR_MAPPING).
    const err = new Error(
      'Could not locate file: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx".'
    )

    // Act / Assert
    expect(modelErrorCode(err)).toBe('MODEL_MISSING')
  })

  test('reports a missing model when only local files are allowed and none are bundled', () => {
    const err = new Error(
      '`local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "models/Xenova/multilingual-e5-small/config.json".'
    )

    expect(modelErrorCode(err)).toBe('MODEL_MISSING')
  })

  test('reports a missing model for a rejected model download (401/403)', () => {
    expect(modelErrorCode(new Error('Unauthorized access to file: "https://huggingface.co/x".'))).toBe(
      'MODEL_MISSING'
    )
    expect(modelErrorCode(new Error('Forbidden access to file: "https://huggingface.co/x".'))).toBe(
      'MODEL_MISSING'
    )
  })

  test('reports a download failure when the host is unreachable', () => {
    // Arrange — Chromium rejects fetch() with a bare TypeError when offline.
    expect(modelErrorCode(new TypeError('Failed to fetch'))).toBe('MODEL_DOWNLOAD_FAILED')
    expect(modelErrorCode(new Error('NetworkError when attempting to fetch resource.'))).toBe(
      'MODEL_DOWNLOAD_FAILED'
    )
    expect(modelErrorCode(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('MODEL_DOWNLOAD_FAILED')
  })

  test('reports a download failure for a server-side outage', () => {
    expect(
      modelErrorCode(
        new Error('Service unavailable error occurred while trying to load file: "https://huggingface.co/x".')
      )
    ).toBe('MODEL_DOWNLOAD_FAILED')
    expect(
      modelErrorCode(
        new Error('Internal server error error occurred while trying to load file: "https://huggingface.co/x".')
      )
    ).toBe('MODEL_DOWNLOAD_FAILED')
  })

  test('falls back to a load failure for an engine-side error', () => {
    // Arrange — ONNX Runtime / WASM failures say nothing about availability.
    const err = new Error(
      'no available backend found. ERR: [wasm] RuntimeError: memory access out of bounds'
    )

    expect(modelErrorCode(err)).toBe('MODEL_LOAD_FAILED')
  })

  test('handles a non-Error throw value', () => {
    expect(modelErrorCode('Could not locate file: "x".')).toBe('MODEL_MISSING')
    expect(modelErrorCode(undefined)).toBe('MODEL_LOAD_FAILED')
  })
})
