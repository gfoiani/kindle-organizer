/**
 * Turns raw label/book cosine similarities into a usable ranking + confidence.
 *
 * Why this exists: e5 similarities live in a narrow high band (measured on a real
 * library: 0.74-0.88, with only ~0.055 of spread *within* a book). Feeding those
 * straight to a softmax over N labels returns roughly 1/N for everything — ~8%
 * with 18 genres — so the top pick looked hopeless even when it was right, and no
 * confidence threshold could separate signal from noise. Three corrections, each
 * measured on that library (top-1 accuracy 23% → 54% before descriptions):
 *
 *  1. per-label centering — kills "hub" labels that sit close to every book;
 *  2. per-author blending — a series by one author gets one coherent verdict;
 *  3. per-book normalization — makes the softmax scale-free, so the reported
 *     percentage means "how much this label stands out for this book".
 */

/** Rows are books, columns are labels. */
export type SimilarityMatrix = number[][]

export interface ScoredBook {
  labelIndex: number
  confidence: number
}

/**
 * Below this, per-label means are computed from too few books to describe the
 * corpus, and centering would just erase the signal (a single book's row becomes
 * all zeros).
 */
const MIN_BOOKS_FOR_CENTERING = 3

/**
 * How far each book moves towards its author's average profile. Swept on the
 * real library: accuracy climbs monotonically to 0.75 (title-only 42%→50%,
 * with online metadata 62%→69%) and then flattens or regresses at 1.0, where a
 * mixed-genre author drags every one of their books to a single verdict.
 */
const AUTHOR_PRIOR_WEIGHT = 0.75

/**
 * Softmax temperature applied to *normalized* scores. At 0.5 a label one standard
 * deviation clear of the pack lands around 40-70% — the range the UI slider was
 * always written for.
 */
const CONFIDENCE_TEMPERATURE = 0.5

/** Subtracts each label's mean similarity across the corpus (hubness fix). */
export function centerByLabel(sims: SimilarityMatrix): SimilarityMatrix {
  if (sims.length < MIN_BOOKS_FOR_CENTERING) return sims

  const means = sims[0].map(
    (_, label) => sims.reduce((total, row) => total + row[label], 0) / sims.length
  )
  return sims.map((row) => row.map((value, label) => value - means[label]))
}

/** Moves every book of a multi-book author towards that author's mean profile. */
export function blendByAuthor(
  sims: SimilarityMatrix,
  authors: string[],
  weight = AUTHOR_PRIOR_WEIGHT
): SimilarityMatrix {
  if (weight === 0) return sims

  const groups = new Map<string, number[]>()
  authors.forEach((author, book) => {
    const key = author.trim().toLowerCase()
    if (!key) return
    groups.set(key, [...(groups.get(key) ?? []), book])
  })

  return sims.map((row, book) => {
    const siblings = groups.get(authors[book].trim().toLowerCase())
    if (!siblings || siblings.length < 2) return row

    return row.map((value, label) => {
      const authorMean =
        siblings.reduce((total, sibling) => total + sims[sibling][label], 0) / siblings.length
      return value * (1 - weight) + authorMean * weight
    })
  })
}

/** Rescales each book's row to zero mean and unit spread. */
export function normalizeByBook(sims: SimilarityMatrix): SimilarityMatrix {
  return sims.map((row) => {
    const mean = row.reduce((total, value) => total + value, 0) / row.length
    const variance = row.reduce((total, value) => total + (value - mean) ** 2, 0) / row.length
    // A book equidistant from every label has no spread to divide by; the guard
    // keeps the row finite (and uniformly zero, i.e. maximally unsure).
    const sd = Math.sqrt(variance) || 1
    return row.map((value) => (value - mean) / sd)
  })
}

/** Softmax with temperature → relative confidence summing to 1. */
export function softmax(values: number[], temperature: number): number[] {
  const scaled = values.map((value) => value / temperature)
  const max = Math.max(...scaled)
  const exps = scaled.map((value) => Math.exp(value - max))
  const sum = exps.reduce((total, value) => total + value, 0)
  return exps.map((value) => value / sum)
}

function argmax(values: number[]): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i
  return best
}

/**
 * Scores a whole library at once — the corrections above are corpus-relative, so
 * every book has to be embedded before any of them can be labelled.
 */
export function scoreLibrary(sims: SimilarityMatrix, authors: string[]): ScoredBook[] {
  const adjusted = normalizeByBook(blendByAuthor(centerByLabel(sims), authors))

  return adjusted.map((row) => {
    const confidences = softmax(row, CONFIDENCE_TEMPERATURE)
    const labelIndex = argmax(confidences)
    return { labelIndex, confidence: confidences[labelIndex] }
  })
}
