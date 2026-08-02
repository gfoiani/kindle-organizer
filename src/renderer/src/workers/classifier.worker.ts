/// <reference types="vite/client" />
import { pipeline, env, type FeatureExtractionPipeline, type Tensor } from '@xenova/transformers'
import type { ClassifierErrorCode, ClassifyRequest, WorkerMessage } from './messages'
import { modelErrorCode } from './modelErrors'
import { scoreLibrary, type SimilarityMatrix } from './scoring'

// Multilingual sentence-embedding model (100+ languages). We classify a book by
// embedding its text and each genre label, then comparing them with cosine
// similarity. Because the model is multilingual, titles and labels in any
// language (Italian, English, …) land in the same semantic space, so the result
// is coherent with whatever language the app/labels are in.
const MODEL_ID = 'Xenova/multilingual-e5-small'

// e5 models expect prefixed inputs, and the asymmetric pairing measured better
// than treating both sides the same: a genre is the question, a book is the
// document being retrieved.
const E5_QUERY_PREFIX = 'query: '
const E5_PASSAGE_PREFIX = 'passage: '

const debug = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.log('[worker]', ...args)
}

/** Type-safe wrapper around self.postMessage for worker→hook messages. */
function post(message: WorkerMessage): void {
  self.postMessage(message)
}

/** Reports a failure as a code the UI localizes; the detail stays in the log. */
function postError(code: ClassifierErrorCode, err?: unknown): void {
  if (err !== undefined) console.error(`[worker] ${code}:`, err)
  post({ type: 'error', code })
}

interface ProgressData {
  status: string
  file?: string
  loaded?: number
  total?: number
}

let extractorPipeline: FeatureExtractionPipeline | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
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
    // In production, point to the bundled model (run: yarn download-model before building).
    // Worker lives in assets/, model is one level up in models/
    env.localModelPath = new URL('../models/', self.location.href).href
    debug('PROD localModelPath =', env.localModelPath)
  }

  extractorPipeline = await pipeline('feature-extraction', MODEL_ID, {
    progress_callback: (data: ProgressData) => {
      if (data.status === 'initiate') {
        post({ type: 'model-loading', progress: 0, stage: { kind: 'loading', file: data.file ?? '' } })
      } else if (data.status === 'downloading' && data.file) {
        const pct = data.total != null && data.loaded != null ? Math.round((data.loaded / data.total) * 100) : 0
        post({ type: 'model-loading', progress: pct, stage: { kind: 'downloading', file: data.file } })
      } else if (data.status === 'done') {
        post({ type: 'model-loading', progress: 100, stage: { kind: 'ready' } })
      }
    }
  })

  return extractorPipeline
}

/** Embeds an already-prefixed text into a normalized vector (cosine-ready). */
async function embed(extractor: FeatureExtractionPipeline, text: string): Promise<Float32Array> {
  const output: Tensor = await extractor(text, { pooling: 'mean', normalize: true })
  // Copy out of the tensor so the underlying buffer can be reused/freed.
  return Float32Array.from(output.data)
}

/** Cosine similarity of two already-normalized vectors (= dot product). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/**
 * A bare genre noun is a weak query: "Storia" sits close to almost any Italian
 * title. Pairing the label with a one-line gloss ("saggi di storia, eventi
 * storici…") lifted top-1 accuracy from 23% to 42% on a real library, so the UI
 * ships a gloss for its built-in genres. Custom labels have none and stay bare.
 */
function labelPrompt(label: string, hint: string | undefined): string {
  return `${E5_QUERY_PREFIX}${hint ? `${label}: ${hint}` : label}`
}

// Cap the online context fed to the embedder — enough for genre signal, short
// enough to stay fast and within the model's window.
const MAX_CONTEXT_CHARS = 500

function bookPrompt(title: string, author: string | undefined, context: string | undefined): string {
  const text = [title, author, context?.slice(0, MAX_CONTEXT_CHARS)].filter(Boolean).join('. ').trim()
  return `${E5_PASSAGE_PREFIX}${text}`
}

self.onmessage = async (event: MessageEvent<ClassifyRequest>) => {
  const { type, books, labels, hints, descriptions } = event.data

  if (type !== 'classify') return

  // Embedding-based classification needs ≥2 labels to be meaningful: with a
  // single label every book trivially scores 100%. The UI also guards this.
  if (!Array.isArray(labels) || labels.length < 2) {
    postError('NEED_TWO_LABELS')
    return
  }

  // Getting the model is the only step that fails for reasons the user can act
  // on — a build without the bundled model downloads ~110 MB on first use — so
  // it is reported apart from a genuine classification failure.
  let extractor: FeatureExtractionPipeline
  try {
    extractor = await getExtractor()
  } catch (err) {
    postError(modelErrorCode(err), err)
    return
  }

  try {
    // Embed every label once up front.
    const labelVectors: Float32Array[] = []
    for (const label of labels) {
      labelVectors.push(await embed(extractor, labelPrompt(label, hints?.[label])))
    }

    // Phase 1 — embed the whole library. Scoring is corpus-relative (see
    // scoring.ts), so no book can be labelled before every book is measured.
    const total = books.length
    const similarities: SimilarityMatrix = []
    for (let i = 0; i < total; i++) {
      const book = books[i]
      const bookVector = await embed(
        extractor,
        bookPrompt(book.title, book.author, descriptions?.[book.path])
      )
      similarities.push(labelVectors.map((labelVector) => cosine(bookVector, labelVector)))
      post({ type: 'progress', current: i + 1, total })
    }

    // Phase 2 — score the corpus and report each verdict.
    const scored = scoreLibrary(
      similarities,
      books.map((book) => book.author ?? '')
    )
    scored.forEach(({ labelIndex, confidence }, i) => {
      post({ type: 'result', book: books[i], label: labels[labelIndex], score: confidence })
    })

    post({ type: 'complete' })
  } catch (err) {
    postError('CLASSIFY_FAILED', err)
  }
}
