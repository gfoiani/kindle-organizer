import { useReducer, useRef, useCallback, useEffect } from 'react'
import type { KindleBook } from '../../../preload/api'
import type { ClassifyRequest, ModelLoadingStage, WorkerMessage } from '../workers/messages'

export interface ClassifyResult {
  book: KindleBook
  label: string
  score: number
}

export type { ModelLoadingStage }

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ClassifierState {
  results: ClassifyResult[]
  progress: { current: number; total: number } | null
  modelStatus: ModelStatus
  modelProgress: number
  modelStage: ModelLoadingStage | null
  isClassifying: boolean
  error: string | null
}

type ClassifierAction =
  | { type: 'CLASSIFY_START' }
  | { type: 'MODEL_LOADING'; progress: number; stage: ModelLoadingStage }
  | { type: 'RESULT'; result: ClassifyResult; current: number; total: number }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' }

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
    case 'RESULT':
      return {
        ...state,
        results: [...state.results, action.result],
        progress: { current: action.current, total: action.total }
      }
    case 'COMPLETE':
      return { ...state, isClassifying: false, modelStatus: 'ready' }
    case 'ERROR':
      return { ...state, isClassifying: false, modelStatus: 'error', error: action.message }
    case 'RESET':
      return { ...initialState, modelStatus: state.modelStatus === 'ready' ? 'ready' : 'idle' }
    default:
      return state
  }
}

export interface UseClassifierReturn extends ClassifierState {
  classify: (books: KindleBook[], labels: string[], descriptions?: Record<string, string>) => void
  reset: () => void
}

export function useClassifier(): UseClassifierReturn {
  const [state, dispatch] = useReducer(reducer, initialState)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
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
        case 'result':
          dispatch({
            type: 'RESULT',
            result: { book: msg.book, label: msg.label, score: msg.score },
            current: msg.current,
            total: msg.total
          })
          break
        case 'complete':
          dispatch({ type: 'COMPLETE' })
          break
        case 'error':
          dispatch({ type: 'ERROR', message: msg.message })
          break
      }
    }

    worker.onerror = (err) => {
      // A failed worker-script load yields an empty err.message; keep a usable fallback.
      dispatch({ type: 'ERROR', message: err.message || 'WORKER_INIT_FAILED' })
    }

    worker.onmessageerror = () => {
      dispatch({ type: 'ERROR', message: 'WORKER_MESSAGE_DESERIALIZE_FAILED' })
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const classify = useCallback(
    (books: KindleBook[], labels: string[], descriptions?: Record<string, string>) => {
      if (!workerRef.current) return
      dispatch({ type: 'CLASSIFY_START' })
      const request: ClassifyRequest = { type: 'classify', books, labels, descriptions }
      workerRef.current.postMessage(request)
    },
    []
  )

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  return { ...state, classify, reset }
}
