/** The file is not a usable EPUB (not a ZIP, no package, no content, entry too large). */
export class EpubInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EpubInvalidError'
  }
}

/** The EPUB's content is encrypted (DRM): it cannot be converted. */
export class EpubDrmError extends Error {
  constructor(message = 'The EPUB is DRM-protected') {
    super(message)
    this.name = 'EpubDrmError'
  }
}

/** Conversion was cancelled via the AbortSignal. Name-matched like requestScheduler. */
export class ConversionAbortError extends Error {
  constructor(message = 'Conversion was cancelled') {
    super(message)
    this.name = 'AbortError'
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ConversionAbortError()
}
