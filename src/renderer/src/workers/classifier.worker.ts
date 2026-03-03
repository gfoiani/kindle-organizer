/// <reference types="vite/client" />
import { pipeline, env } from '@xenova/transformers'
import type { KindleBook } from '../../../preload/api'

const MODEL_ID = 'Xenova/mobilebert-uncased-mnli'

console.log('[worker] loaded, DEV=', import.meta.env.DEV)

interface ProgressData {
  status: string
  file?: string
  loaded?: number
  total?: number
}

interface ZeroShotResult {
  labels: string[]
  scores: number[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let classifierPipeline: any = null

async function getClassifier() {
  if (classifierPipeline) return classifierPipeline

  console.log('[worker] getClassifier() called')
  console.log('[worker] env.backends?.onnx:', env.backends?.onnx)
  console.log('[worker] env.allowLocalModels:', env.allowLocalModels)
  console.log('[worker] env.localModelPath:', env.localModelPath)
  console.log('[worker] env.allowRemoteModels:', env.allowRemoteModels)
  console.log('[worker] self.location.href:', self.location.href)

  // Configure ONNX backend lazily — env.backends.onnx uses a webpack lazy getter
  // that may not be initialized at module load time with Vite's CJS→ESM transform.
  // By the time getClassifier() is called, all modules are fully evaluated.
  if (env.backends?.onnx?.wasm) {
    // Disable proxy worker — would fail CSP in Electron's renderer
    env.backends.onnx.wasm.proxy = false
    if (!import.meta.env.DEV) {
      // WASM files copied by vite-plugin-static-copy alongside the worker bundle in assets/
      env.backends.onnx.wasm.wasmPaths = './'
    }
  } else {
    console.warn('[worker] env.backends.onnx.wasm not available — WASM proxy not configured')
  }

  if (import.meta.env.DEV) {
    // In dev mode the models/ dir doesn't exist locally (excluded from git).
    // Without this, transformers.js fetches /models/... which Vite's SPA fallback
    // serves as index.html → JSON parse error "Unexpected token '<'".
    env.allowLocalModels = false
    // Disable browser Cache API in dev mode. On a previous run (when allowLocalModels
    // was still true), hub.js fetched /models/... got HTML from Vite's SPA fallback
    // (status 200), and cached it. tryCache() checks localPath BEFORE allowLocalModels
    // is respected, so the stale HTML response is returned from cache on every subsequent
    // run. Setting useBrowserCache=false bypasses the cache entirely in dev mode.
    env.useBrowserCache = false
    console.log('[worker] DEV: allowLocalModels=false, useBrowserCache=false')
  } else {
    // In production, point to bundled model (run: npm run download-model before building).
    // Worker lives in assets/, model is one level up in models/
    env.localModelPath = new URL('../models/', self.location.href).href
    console.log('[worker] PROD: localModelPath =', env.localModelPath)
  }

  console.log('[worker] starting pipeline(), allowLocalModels=', env.allowLocalModels, 'allowRemoteModels=', env.allowRemoteModels)

  classifierPipeline = await pipeline('zero-shot-classification', MODEL_ID, {
    progress_callback: (data: ProgressData) => {
      if (data.status === 'initiate') {
        self.postMessage({ type: 'model-loading', progress: 0, stage: `Loading ${data.file ?? 'model'}...` })
      } else if (data.status === 'downloading' && data.file) {
        const pct = data.total ? Math.round((data.loaded! / data.total) * 100) : 0
        self.postMessage({ type: 'model-loading', progress: pct, stage: `Downloading ${data.file}` })
      } else if (data.status === 'done') {
        self.postMessage({ type: 'model-loading', progress: 100, stage: 'Model ready' })
      }
    }
  })

  return classifierPipeline
}

self.onmessage = async (event: MessageEvent) => {
  const { type, books, labels } = event.data as {
    type: string
    books: KindleBook[]
    labels: string[]
  }

  if (type !== 'classify') return

  try {
    const classifier = await getClassifier()
    const total = books.length

    for (let i = 0; i < total; i++) {
      const book = books[i]
      const text = [book.title, book.author].filter(Boolean).join(' ').trim()
      const result = (await classifier(text, labels, { multi_label: false })) as ZeroShotResult

      self.postMessage({
        type: 'result',
        book,
        label: result.labels[0],
        score: result.scores[0],
        current: i + 1,
        total
      })
    }

    self.postMessage({ type: 'complete' })
  } catch (err) {
    console.error('[worker] caught error:', err)
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}
