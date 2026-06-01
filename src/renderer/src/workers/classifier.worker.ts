/// <reference types="vite/client" />
import { pipeline, env } from '@xenova/transformers'
import type { KindleBook } from '../../../preload/api'

// Multilingual sentence-embedding model (100+ languages). We classify a book by
// embedding its text and each genre label, then comparing them with cosine
// similarity. Because the model is multilingual, titles and labels in any
// language (Italian, English, …) land in the same semantic space, so the result
// is coherent with whatever language the app/labels are in.
const MODEL_ID = 'Xenova/multilingual-e5-small'

// e5 models expect inputs to be prefixed. "query: " is recommended for short
// texts; we use it for both the book text and the labels (symmetric matching).
const E5_PREFIX = 'query: '

// Temperature for turning raw cosine similarities into a relative confidence.
// e5 similarities cluster in a narrow high range, so we sharpen with a small
// temperature before softmax. Lower = more decisive. Tunable.
const SOFTMAX_TEMPERATURE = 0.05

const debug = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.log('[worker]', ...args)
}

interface ProgressData {
  status: string
  file?: string
  loaded?: number
  total?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPipeline: any = null

async function getExtractor() {
  if (extractorPipeline) return extractorPipeline

  // Configure ONNX backend lazily — env.backends.onnx uses a webpack lazy getter
  // that may not be initialized at module load time with Vite's CJS→ESM transform.
  // By the time getExtractor() is called, all modules are fully evaluated.
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
    // Disable browser Cache API in dev mode to avoid caching Vite's HTML fallback
    // for missing model files (see git history for the full rationale).
    env.useBrowserCache = false
  } else {
    // In production, point to the bundled model (run: npm run download-model before building).
    // Worker lives in assets/, model is one level up in models/
    env.localModelPath = new URL('../models/', self.location.href).href
    debug('PROD localModelPath =', env.localModelPath)
  }

  extractorPipeline = await pipeline('feature-extraction', MODEL_ID, {
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

  return extractorPipeline
}

/** Embeds a single text into a normalized vector (cosine-ready). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function embed(extractor: any, text: string): Promise<Float32Array> {
  const output = await extractor(`${E5_PREFIX}${text}`, { pooling: 'mean', normalize: true })
  // Copy out of the tensor so the underlying buffer can be reused/freed.
  return Float32Array.from(output.data as Float32Array)
}

/** Cosine similarity of two already-normalized vectors (= dot product). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** Softmax over similarities with temperature → relative confidence summing to 1. */
function softmax(values: number[], temperature: number): number[] {
  const scaled = values.map((v) => v / temperature)
  const max = Math.max(...scaled)
  const exps = scaled.map((v) => Math.exp(v - max))
  const sum = exps.reduce((acc, v) => acc + v, 0)
  return exps.map((v) => v / sum)
}

// Cap how much description text feeds the embedder — enough for genre signal,
// short enough to stay fast and within the model's context.
const MAX_DESCRIPTION_CHARS = 500

self.onmessage = async (event: MessageEvent) => {
  const { type, books, labels, descriptions } = event.data as {
    type: string
    books: KindleBook[]
    labels: string[]
    descriptions?: Record<string, string>
  }

  if (type !== 'classify') return

  try {
    const extractor = await getExtractor()

    // Embed every label once up front.
    const labelVectors: Float32Array[] = []
    for (const label of labels) {
      labelVectors.push(await embed(extractor, label))
    }

    const total = books.length

    for (let i = 0; i < total; i++) {
      const book = books[i]
      const description = descriptions?.[book.path]?.slice(0, MAX_DESCRIPTION_CHARS)
      const text = [book.title, book.author, description].filter(Boolean).join('. ').trim()
      const bookVector = await embed(extractor, text)

      const sims = labelVectors.map((labelVec) => cosine(bookVector, labelVec))
      const confidences = softmax(sims, SOFTMAX_TEMPERATURE)

      let bestIdx = 0
      for (let j = 1; j < confidences.length; j++) {
        if (confidences[j] > confidences[bestIdx]) bestIdx = j
      }

      self.postMessage({
        type: 'result',
        book,
        label: labels[bestIdx],
        score: confidences[bestIdx],
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
