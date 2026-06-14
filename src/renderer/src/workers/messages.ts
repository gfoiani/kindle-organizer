import type { KindleBook } from '../../../preload/api'

/**
 * Machine-readable model-loading stages emitted by the worker. The renderer
 * translates these into localized strings (no hardcoded English in the worker).
 */
export type ModelLoadingStage =
  | { kind: 'loading'; file: string }
  | { kind: 'downloading'; file: string }
  | { kind: 'ready' }

/** Request sent from the hook to the worker to classify books against labels. */
export interface ClassifyRequest {
  type: 'classify'
  books: KindleBook[]
  labels: string[]
  descriptions?: Record<string, string>
}

/** Messages posted from the worker back to the hook. */
export type WorkerMessage =
  | { type: 'model-loading'; progress: number; stage: ModelLoadingStage }
  | { type: 'result'; book: KindleBook; label: string; score: number; current: number; total: number }
  | { type: 'complete' }
  | { type: 'error'; message: string }
