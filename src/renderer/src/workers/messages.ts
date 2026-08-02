import type { KindleBook } from '../../../preload/api'

/**
 * Machine-readable model-loading stages emitted by the worker. The renderer
 * translates these into localized strings (no hardcoded English in the worker).
 */
export type ModelLoadingStage =
  | { kind: 'loading'; file: string }
  | { kind: 'downloading'; file: string }
  | { kind: 'ready' }

/**
 * Machine-readable failures the classifier can report. The renderer maps each
 * one to a localized message (`utils/classifierError.ts`), so no English text
 * ever crosses this boundary.
 *
 * The model codes are deliberately separate: the ~110 MB model is not bundled
 * with every build, so "it isn't there" / "it couldn't be downloaded" are the
 * common cases and must not read as a generic engine failure.
 */
export type ClassifierErrorCode =
  | 'NEED_TWO_LABELS'
  | 'MODEL_MISSING'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'CLASSIFY_FAILED'
  | 'WORKER_INIT_FAILED'
  | 'WORKER_MESSAGE_DESERIALIZE_FAILED'

/** Request sent from the hook to the worker to classify books against labels. */
export interface ClassifyRequest {
  type: 'classify'
  books: KindleBook[]
  labels: string[]
  /** Label → one-line gloss, keyed by the label itself. Built-in genres only. */
  hints?: Record<string, string>
  /** Book path → online context (provider genre + description) to classify on. */
  descriptions?: Record<string, string>
}

/** Messages posted from the worker back to the hook. */
export type WorkerMessage =
  | { type: 'model-loading'; progress: number; stage: ModelLoadingStage }
  /**
   * Emitted per book while the library is being embedded. Results cannot stream
   * alongside it: the confidence of one book depends on the whole corpus, so
   * every verdict arrives at the end.
   */
  | { type: 'progress'; current: number; total: number }
  | { type: 'result'; book: KindleBook; label: string; score: number }
  | { type: 'complete' }
  | { type: 'error'; code: ClassifierErrorCode }
