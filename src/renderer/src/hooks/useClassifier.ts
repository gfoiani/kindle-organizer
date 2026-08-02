import { useReducer, useRef, useCallback, useEffect } from 'react'
import type { KindleBook } from '../../../preload/api'
import type {
  ClassifierErrorCode,
  ClassifyRequest,
  ModelLoadingStage,
  WorkerMessage
} from '../workers/messages'

export interface ClassifyResult {
  book: KindleBook
  label: string
  score: number
}

export type { ClassifierErrorCode, ModelLoadingStage }

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ClassifierState {
  results: ClassifyResult[]
  progress: { current: number; total: number } | null
  modelStatus: ModelStatus
  modelProgress: number
  modelStage: ModelLoadingStage | null
  isClassifying: boolean
  /** Machine-readable code; localized by `utils/classifierError.ts`. */
  error: ClassifierErrorCode | null
}

type ClassifierAction =
  | { type: 'CLASSIFY_START' }
  | { type: 'MODEL_LOADING'; progress: number; stage: ModelLoadingStage }
  | { type: 'PROGRESS'; current: number; total: number }
  | { type: 'RESULT'; result: ClassifyResult }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; code: ClassifierErrorCode }
  | { type: 'RESET' }
  | { type: 'CANCELLED' }

const initialState: ClassifierState = {
  results: [],
  progress: null,
  modelStatus: 'idle',
  modelProgress: 0,
  modelStage: null,
  isClassifying: false,
  error: null
}

function reducer(state: ClassifierState, action: ClassifierAction): ClassifierState {
  switch (action.type) {
    case 'CLASSIFY_START':
      return { ...state, results: [], progress: null, isClassifying: true, error: null }
    case 'MODEL_LOADING':
      return { ...state, modelStatus: 'loading', modelProgress: action.progress, modelStage: action.stage }
    case 'PROGRESS':
      return { ...state, progress: { current: action.current, total: action.total } }
    case 'RESULT':
      return { ...state, results: [...state.results, action.result] }
    case 'COMPLETE':
      return { ...state, isClassifying: false, modelStatus: 'ready' }
    case 'ERROR':
      return { ...state, isClassifying: false, modelStatus: 'error', error: action.code }
    case 'RESET':
      return { ...initialState, modelStatus: state.modelStatus === 'ready' ? 'ready' : 'idle' }
    case 'CANCELLED':
      // Full reset, modelStatus included: cancelling replaces the worker, and
      // the fresh one has no model loaded yet.
      return initialState
    default:
      return state
  }
}

export interface UseClassifierReturn extends ClassifierState {
  classify: (
    books: KindleBook[],
    labels: string[],
    options?: { hints?: Record<string, string>; descriptions?: Record<string, string> }
  ) => void
  reset: () => void
  /** Aborts an in-flight run (see the implementation for why this terminates the worker). */
  cancel: () => void
}

export function useClassifier(): UseClassifierReturn {
  const [state, dispatch] = useReducer(reducer, initialState)
  const workerRef = useRef<Worker | null>(null)

  // Shared by the mount effect and cancel(): aborting a run replaces the worker,
  // so spawning has to be callable more than once.
  const spawnWorker = useCallback((): void => {
    const worker = new Worker(new URL('../workers/classifier.worker.ts', import.meta.url), {
      type: 'module'
    })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data
      switch (msg.type) {
        case 'model-loading':
          dispatch({ type: 'MODEL_LOADING', progress: msg.progress, stage: msg.stage })
          break
        case 'progress':
          dispatch({ type: 'PROGRESS', current: msg.current, total: msg.total })
          break
        case 'result':
          dispatch({
            type: 'RESULT',
            result: { book: msg.book, label: msg.label, score: msg.score }
          })
          break
        case 'complete':
          dispatch({ type: 'COMPLETE' })
          break
        case 'error':
          dispatch({ type: 'ERROR', code: msg.code })
          break
      }
    }

    worker.onerror = (err) => {
      // The script itself could not be loaded or ran into an uncaught error.
      // A load failure (CSP, missing chunk) carries an empty message, so log
      // whatever context the event has — it is the only trace of the cause.
      console.error(
        '[classifier] worker failed to start:',
        err.message || '(no message — the script was blocked or could not be fetched)',
        err.filename ?? '',
        err.lineno ?? ''
      )
      dispatch({ type: 'ERROR', code: 'WORKER_INIT_FAILED' })
    }

    worker.onmessageerror = () => {
      dispatch({ type: 'ERROR', code: 'WORKER_MESSAGE_DESERIALIZE_FAILED' })
    }
  }, [])

  useEffect(() => {
    spawnWorker()
    // Tear down whichever worker is current — cancel() may have replaced the one
    // this effect originally spawned.
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [spawnWorker])

  const classify = useCallback(
    (
      books: KindleBook[],
      labels: string[],
      options?: { hints?: Record<string, string>; descriptions?: Record<string, string> }
    ) => {
      if (!workerRef.current) return
      dispatch({ type: 'CLASSIFY_START' })
      const request: ClassifyRequest = {
        type: 'classify',
        books,
        labels,
        hints: options?.hints,
        descriptions: options?.descriptions
      }
      workerRef.current.postMessage(request)
    },
    []
  )

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  /**
   * Aborts an in-flight run.
   *
   * Terminating is the only reliable stop: the worker classifies inside a plain
   * `for await` loop with no yield point, and the transformers.js `pipeline()`
   * call — which is where a first run spends most of its time downloading the
   * model — takes no AbortSignal. A postMessage would simply sit in the queue
   * until the current task finished, which is exactly what we are cancelling.
   *
   * A replacement worker is spawned immediately so the next Analyze works; the
   * cost is that the model has to load again.
   */
  const cancel = useCallback(() => {
    workerRef.current?.terminate()
    spawnWorker()
    dispatch({ type: 'CANCELLED' })
  }, [spawnWorker])

  return { ...state, classify, reset, cancel }
}
