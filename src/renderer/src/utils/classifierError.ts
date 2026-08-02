import type { ClassifierErrorCode } from '../workers/messages'

/**
 * i18n key for each failure the classifier worker can report.
 *
 * Declared as a FULL `Record<ClassifierErrorCode, string>` on purpose: adding a
 * code to `workers/messages.ts` breaks this file's compile until the code is
 * given a message, so the worker and the UI can never drift — the same guarantee
 * `utils/appError.ts` gives for main-process codes.
 */
const CODE_MESSAGE_KEYS: Record<ClassifierErrorCode, string> = {
  NEED_TWO_LABELS: 'aiClassify.needMoreLabels',
  // The model is ~110 MB and is not bundled with every build, so its three
  // failure modes are kept apart: absent, undownloadable, or broken on load.
  MODEL_MISSING: 'aiClassify.modelMissing',
  MODEL_DOWNLOAD_FAILED: 'aiClassify.modelDownloadFailed',
  MODEL_LOAD_FAILED: 'aiClassify.modelLoadFailed',
  CLASSIFY_FAILED: 'aiClassify.workerError',
  WORKER_INIT_FAILED: 'aiClassify.workerInitFailed',
  WORKER_MESSAGE_DESERIALIZE_FAILED: 'aiClassify.workerError'
}

/** Every declared code, for exhaustive tests. Safe cast: the Record is total. */
export const CLASSIFIER_ERROR_CODES = Object.keys(CODE_MESSAGE_KEYS) as ClassifierErrorCode[]

/** Picks the localized message for a classifier failure. */
export function classifierErrorKey(code: ClassifierErrorCode): string {
  return CODE_MESSAGE_KEYS[code]
}
