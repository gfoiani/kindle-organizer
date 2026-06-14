import { useState, useRef, useEffect, useMemo, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClassifyResult, ModelLoadingStage, UseClassifierReturn } from '../hooks/useClassifier'
import type { KindleBook, Collection } from '../../../preload/api'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Label {
  key: string      // stable identifier (React key + dedup); English for the defaults
  display: string  // localized name shown in the UI, sent to the multilingual model, and used as the collection name
}

const DEFAULT_GENRE_KEYS: Array<{ key: string; i18nKey: string }> = [
  { key: 'Fantasy', i18nKey: 'fantasy' },
  { key: 'Science Fiction', i18nKey: 'scienceFiction' },
  { key: 'Thriller', i18nKey: 'thriller' },
  { key: 'Mystery', i18nKey: 'mystery' },
  { key: 'Horror', i18nKey: 'horror' },
  { key: 'Romance', i18nKey: 'romance' },
  { key: 'Historical Fiction', i18nKey: 'historicalFiction' },
  { key: 'Literary Fiction', i18nKey: 'literaryFiction' },
  { key: 'Biography', i18nKey: 'biography' },
  { key: 'History', i18nKey: 'history' },
  { key: 'Science', i18nKey: 'science' },
  { key: 'Technology', i18nKey: 'technology' },
  { key: 'Self-Help', i18nKey: 'selfHelp' },
  { key: 'Psychology', i18nKey: 'psychology' },
  { key: 'Philosophy', i18nKey: 'philosophy' },
  { key: 'Business', i18nKey: 'business' },
  { key: 'Travel', i18nKey: 'travel' },
  { key: 'Cooking', i18nKey: 'cooking' }
]

// Embedding-based classification needs at least two categories to discriminate;
// with one label every book trivially scores 100%.
const MIN_LABELS = 2

interface AutoClassifyModalProps {
  books: KindleBook[]
  collections: Collection[]
  classifier: UseClassifierReturn
  onApply: (
    suggestions: ClassifyResult[],
    threshold: number,
    deleteExisting: boolean,
    groupByAuthor: boolean
  ) => Promise<void>
  onClose: () => void
}

export function AutoClassifyModal({
  books,
  collections,
  classifier,
  onApply,
  onClose
}: AutoClassifyModalProps) {
  const { t } = useTranslation()
  const { classify, results, progress, modelStatus, modelProgress, modelStage, isClassifying, error, reset } =
    classifier

  const [labels, setLabels] = useState<Label[]>(() =>
    DEFAULT_GENRE_KEYS.map(({ key, i18nKey }) => ({
      key,
      display: t(`aiClassify.genres.${i18nKey}`)
    }))
  )
  const [newLabelInput, setNewLabelInput] = useState('')
  // Embedding-based confidence is relative across labels; 40% is a sensible
  // starting point. Tune the slider per library (and SOFTMAX_TEMPERATURE in the worker).
  const [threshold, setThreshold] = useState(40)
  const [deleteExisting, setDeleteExisting] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [useDescriptions, setUseDescriptions] = useState(false)
  const [groupByAuthor, setGroupByAuthor] = useState(true)
  const [descFetch, setDescFetch] = useState<{ current: number; total: number } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const newLabelRef = useRef<HTMLInputElement>(null)
  const resultsEndRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const hasStarted = isClassifying || results.length > 0 || progress !== null || descFetch !== null
  const isBusy = isClassifying || isApplying || descFetch !== null

  const filteredResults = useMemo(
    () => results.filter((r) => r.score * 100 >= threshold),
    [results, threshold]
  )
  const uniqueDisplayLabels = useMemo(
    () => [...new Set(filteredResults.map((r) => r.label))],
    [filteredResults]
  )
  const newCollectionCount = useMemo(
    () => uniqueDisplayLabels.filter((l) => !collections.some((c) => c.name === l)).length,
    [uniqueDisplayLabels, collections]
  )

  // Translate the worker's machine-readable model-loading stage into UI text.
  const modelStageText = useMemo(() => translateModelStage(modelStage, t), [modelStage, t])

  // Map the worker's machine-readable error codes to localized messages.
  const displayError = useMemo(() => translateClassifierError(error, t), [error, t])

  // Focus containment + restore focus on close.
  useFocusTrap(dialogRef, { onEscape: isBusy ? undefined : onClose, trapTab: true })

  // Auto-scroll results as they arrive
  useEffect(() => {
    resultsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [results.length])

  function handleAddLabel() {
    const trimmed = newLabelInput.trim()
    if (trimmed && !labels.some((l) => l.display === trimmed || l.key === trimmed)) {
      setLabels([...labels, { key: trimmed, display: trimmed }])
      setNewLabelInput('')
      newLabelRef.current?.focus()
    }
  }

  function handleRemoveLabel(key: string) {
    setLabels(labels.filter((l) => l.key !== key))
  }

  function handleLabelKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleAddLabel()
  }

  async function handleAnalyze() {
    reset()
    setApplyError(null)
    setDescFetch(null)
    // Send the localized display labels: the multilingual model matches them
    // against book titles in any language, and they double as collection names.
    const displayLabels = labels.map((l) => l.display)

    if (!useDescriptions) {
      classify(books, displayLabels)
      return
    }

    // Opt-in: fetch a short online description per book to give the classifier
    // more signal than the title alone. Rate-limited, so we show progress.
    setDescFetch({ current: 0, total: books.length })
    const descriptions: Record<string, string> = {}
    for (let i = 0; i < books.length; i++) {
      const book = books[i]
      try {
        const meta = await window.kindleAPI.getBookMetadata(book.title, book.author)
        if (meta?.description) descriptions[book.path] = meta.description
      } catch (err) {
        console.error('Failed to fetch description:', err)
      }
      setDescFetch({ current: i + 1, total: books.length })
    }
    setDescFetch(null)
    classify(books, displayLabels, descriptions)
  }

  async function handleApply() {
    // Confirm the irreversible bulk delete before applying.
    if (deleteExisting) {
      const confirmed = window.confirm(
        t('aiClassify.confirmDeleteAll', { count: collections.length })
      )
      if (!confirmed) return
    }
    setIsApplying(true)
    setApplyError(null)
    try {
      await onApply(filteredResults, threshold, deleteExisting, groupByAuthor)
    } catch (err) {
      console.error('Failed to apply suggestions:', err)
      setApplyError(t('aiClassify.applyError'))
    } finally {
      setIsApplying(false)
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget && !isBusy) {
      onClose()
    }
  }

  const canAnalyze = labels.length >= MIN_LABELS && books.length > 0 && !isClassifying
  const canApply = filteredResults.length > 0 && !isApplying && !isClassifying
  const shownError = displayError ?? applyError

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={handleOverlayClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2.5">
            <svg aria-hidden="true" className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
              />
            </svg>
            <h2 id={titleId} className="text-white font-semibold">{t('aiClassify.title')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            aria-label={t('aiClassify.close')}
            className="text-gray-400 hover:text-gray-300 transition-colors disabled:opacity-40 p-1 rounded"
          >
            <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Labels section */}
          <div className="px-5 py-4 border-b border-gray-700/50">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2.5">
              {t('aiClassify.categoriesLabel')}
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {labels.map((label) => (
                <span
                  key={label.key}
                  className="flex items-center gap-1 bg-indigo-900/50 text-indigo-300 text-xs px-2.5 py-1 rounded-full border border-indigo-700/50"
                >
                  {label.display}
                  <button
                    onClick={() => handleRemoveLabel(label.key)}
                    disabled={hasStarted}
                    aria-label={t('aiClassify.removeLabel', { label: label.display })}
                    className="text-indigo-400 hover:text-indigo-200 transition-colors disabled:opacity-30 ml-0.5"
                  >
                    <svg aria-hidden="true" className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            {!hasStarted && labels.length < MIN_LABELS && (
              <p className="text-yellow-500/80 text-xs mb-2">{t('aiClassify.needMoreLabels')}</p>
            )}
            {!hasStarted && (
              <div className="flex gap-2">
                <input
                  ref={newLabelRef}
                  value={newLabelInput}
                  onChange={(e) => setNewLabelInput(e.target.value)}
                  onKeyDown={handleLabelKeyDown}
                  placeholder={t('aiClassify.addLabelPlaceholder')}
                  className="flex-1 bg-gray-700 text-white text-sm rounded-md px-3 py-1.5 outline-none ring-0 focus:ring-1 focus:ring-indigo-500 placeholder-gray-400"
                />
                <button
                  onClick={handleAddLabel}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md transition-colors"
                >
                  {t('aiClassify.addLabel')}
                </button>
              </div>
            )}
            {!hasStarted && (
              <label className="flex items-center gap-2 mt-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useDescriptions}
                  onChange={(e) => setUseDescriptions(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-indigo-500 cursor-pointer"
                />
                <span className="text-xs text-gray-400">{t('aiClassify.useDescriptions')}</span>
              </label>
            )}
            {!hasStarted && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={groupByAuthor}
                  onChange={(e) => setGroupByAuthor(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-indigo-500 cursor-pointer"
                />
                <span className="text-xs text-gray-400">{t('aiClassify.groupByAuthor')}</span>
              </label>
            )}
          </div>

          {/* Analyze button + progress */}
          <div className="px-5 py-4 border-b border-gray-700/50">
            {!hasStarted ? (
              <button
                onClick={handleAnalyze}
                disabled={!canAnalyze}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
              >
                <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {t('aiClassify.analyzeBooks', { count: books.length })}
              </button>
            ) : (
              <div className="space-y-2" role="status" aria-live="polite">
                {/* Description fetch progress (opt-in enrichment) */}
                {descFetch && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-400 text-xs">
                        {t('aiClassify.fetchingDescriptions', { current: descFetch.current, total: descFetch.total })}
                      </span>
                      <span className="text-gray-400 text-xs">
                        {Math.round((descFetch.current / descFetch.total) * 100)}%
                      </span>
                    </div>
                    <div
                      className="h-1 bg-gray-700 rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuenow={descFetch.current}
                      aria-valuemin={0}
                      aria-valuemax={descFetch.total}
                    >
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                        style={{ width: `${(descFetch.current / descFetch.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Model loading progress */}
                {modelStatus === 'loading' && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-400 text-xs">{modelStageText}</span>
                      <span className="text-gray-400 text-xs">{modelProgress}%</span>
                    </div>
                    <div
                      className="h-1 bg-gray-700 rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuenow={modelProgress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                        style={{ width: `${modelProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Books classification progress */}
                {progress && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-400 text-xs">
                        {t('aiClassify.analyzingProgress', { current: progress.current, total: progress.total })}
                      </span>
                      <span className="text-gray-400 text-xs">
                        {Math.round((progress.current / progress.total) * 100)}%
                      </span>
                    </div>
                    <div
                      className="h-1 bg-gray-700 rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuenow={progress.current}
                      aria-valuemin={0}
                      aria-valuemax={progress.total}
                    >
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                        style={{ width: `${(progress.current / progress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {isClassifying && !progress && modelStatus !== 'loading' && (
                  <div className="flex items-center gap-2 text-gray-400 text-xs">
                    <svg aria-hidden="true" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    {t('aiClassify.preparingModel')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Error */}
          {shownError && (
            <div role="alert" className="mx-5 my-3 px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-lg text-red-300 text-sm">
              {shownError}
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="px-5 py-4">
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2.5">
                {t('aiClassify.results')}
              </p>
              <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                {results.map((result) => {
                  const pct = Math.round(result.score * 100)
                  const isAbove = pct >= threshold
                  return (
                    <div
                      key={result.book.path}
                      className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-opacity ${
                        isAbove ? 'opacity-100' : 'opacity-40'
                      }`}
                    >
                      <span aria-hidden="true" className={`shrink-0 text-xs ${isAbove ? 'text-green-400' : 'text-gray-500'}`}>
                        {isAbove ? '✓' : '—'}
                      </span>
                      <span className="flex-1 text-gray-300 truncate min-w-0">{result.book.title}</span>
                      <span className="shrink-0 text-indigo-400 text-xs font-medium">
                        {result.label}
                      </span>
                      <span
                        className={`shrink-0 text-xs font-mono w-9 text-right ${
                          pct >= 80 ? 'text-green-400' : pct >= 60 ? 'text-yellow-400' : 'text-gray-400'
                        }`}
                      >
                        {pct}%
                      </span>
                    </div>
                  )
                })}
                <div ref={resultsEndRef} />
              </div>
            </div>
          )}

          {/* Threshold slider (show once there are results) */}
          {results.length > 0 && (
            <div className="px-5 pb-4">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-gray-400 text-xs font-semibold uppercase tracking-wider">
                  {t('aiClassify.thresholdLabel')}
                </label>
                <span className="text-indigo-400 text-sm font-mono">{threshold}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                aria-label={t('aiClassify.thresholdLabel')}
                className="w-full h-1.5 accent-indigo-500 cursor-pointer"
              />
              <p className="text-gray-400 text-xs mt-2">
                {t('aiClassify.summary', {
                  books: filteredResults.length,
                  collections: uniqueDisplayLabels.length,
                  newCollections: newCollectionCount
                })}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-gray-700 shrink-0">
          {/* Delete existing checkbox — only shown when there are collections to delete */}
          <div className="flex items-center">
            {results.length > 0 && collections.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deleteExisting}
                  onChange={(e) => setDeleteExisting(e.target.checked)}
                  disabled={isApplying}
                  className="w-3.5 h-3.5 rounded accent-red-500 cursor-pointer disabled:opacity-40"
                />
                <span className={`text-xs ${deleteExisting ? 'text-red-400' : 'text-gray-400'}`}>
                  {t('aiClassify.deleteExisting', { count: collections.length })}
                </span>
              </label>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isBusy}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-40"
            >
              {t('aiClassify.cancel')}
            </button>
            {results.length > 0 && (
              <button
                onClick={handleApply}
                disabled={!canApply}
                className={`flex items-center gap-2 px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors ${
                  deleteExisting ? 'bg-red-700 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-500'
                }`}
              >
                {isApplying && (
                  <svg aria-hidden="true" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                )}
                {isApplying ? t('aiClassify.applying') : t('aiClassify.apply', { count: filteredResults.length })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Translates the worker's machine-readable model-loading stage into UI text. */
function translateModelStage(
  stage: ModelLoadingStage | null,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (!stage) return ''
  switch (stage.kind) {
    case 'loading':
      return t('aiClassify.modelLoading', { file: stage.file })
    case 'downloading':
      return t('aiClassify.modelDownloading', { file: stage.file })
    case 'ready':
      return t('aiClassify.modelReady')
    default:
      return ''
  }
}

/** Maps worker error codes to localized, user-friendly messages. */
function translateClassifierError(
  error: string | null,
  t: (key: string) => string
): string | null {
  if (!error) return null
  switch (error) {
    case 'NEED_TWO_LABELS':
      return t('aiClassify.needMoreLabels')
    case 'WORKER_INIT_FAILED':
      return t('aiClassify.workerInitFailed')
    case 'WORKER_MESSAGE_DESERIALIZE_FAILED':
      return t('aiClassify.workerError')
    default:
      return error
  }
}
