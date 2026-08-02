import { describe, expect, test } from 'vitest'
import {
  blendByAuthor,
  centerByLabel,
  normalizeByBook,
  scoreLibrary,
  softmax
} from '../src/renderer/src/workers/scoring'

describe('centerByLabel', () => {
  test('strips the advantage of a label that is close to every book', () => {
    // Arrange — label 0 is a "hub": nearest to every book in absolute terms.
    const sims = [
      [0.9, 0.8],
      [0.9, 0.6],
      [0.9, 0.7]
    ]

    // Act
    const centered = centerByLabel(sims)

    // Assert — book 0 now prefers label 1, which it likes more than average.
    expect(centered[0][0]).toBeCloseTo(0)
    expect(centered[0][1]).toBeCloseTo(0.1)
    expect(centered[0][1]).toBeGreaterThan(centered[0][0])
    expect(centered[1][1]).toBeCloseTo(-0.1)
  })

  test('leaves the matrix untouched when there are too few books to average', () => {
    const sims = [[0.88, 0.81, 0.77]]

    expect(centerByLabel(sims)).toEqual(sims)
  })
})

describe('normalizeByBook', () => {
  test('rescales each book to zero mean and unit spread', () => {
    const [row] = normalizeByBook([[0.8, 0.82, 0.84]])

    const mean = row.reduce((a, v) => a + v, 0) / row.length
    const sd = Math.sqrt(row.reduce((a, v) => a + (v - mean) ** 2, 0) / row.length)
    expect(mean).toBeCloseTo(0)
    expect(sd).toBeCloseTo(1)
  })

  test('keeps the ranking of a book intact', () => {
    const [row] = normalizeByBook([[0.75, 0.88, 0.8]])

    expect(row[1]).toBeGreaterThan(row[2])
    expect(row[2]).toBeGreaterThan(row[0])
  })

  test('survives a book that is equidistant from every label', () => {
    const [row] = normalizeByBook([[0.8, 0.8, 0.8]])

    expect(row.every(Number.isFinite)).toBe(true)
  })
})

describe('blendByAuthor', () => {
  test('pulls books by the same author towards their shared profile', () => {
    // Arrange — two books by one author pointing at opposite labels.
    const sims = [
      [1, 0],
      [0, 1]
    ]

    // Act
    const blended = blendByAuthor(sims, ['Glenn Cooper', 'Glenn Cooper'], 0.5)

    // Assert — both move halfway to the author's mean of [0.5, 0.5].
    expect(blended[0]).toEqual([0.75, 0.25])
    expect(blended[1]).toEqual([0.25, 0.75])
  })

  test('leaves an author with a single book unchanged', () => {
    const sims = [
      [1, 0],
      [0, 1]
    ]

    expect(blendByAuthor(sims, ['A', 'B'], 0.5)).toEqual(sims)
  })

  test('ignores blank author names and matches case-insensitively', () => {
    const sims = [
      [1, 0],
      [0, 1],
      [1, 1]
    ]

    const blended = blendByAuthor(sims, ['glenn cooper', 'Glenn Cooper', ''], 0.5)
    expect(blended[0]).toEqual([0.75, 0.25])
    expect(blended[2]).toEqual([1, 1])
  })

  test('is a no-op at weight 0', () => {
    const sims = [
      [1, 0],
      [0, 1]
    ]

    expect(blendByAuthor(sims, ['A', 'A'], 0)).toEqual(sims)
  })
})

describe('softmax', () => {
  test('produces a distribution that sums to 1', () => {
    const probs = softmax([1, 2, 3], 1)

    expect(probs.reduce((a, v) => a + v, 0)).toBeCloseTo(1)
  })

  test('sharpens as the temperature drops', () => {
    const warm = softmax([1, 2], 1)
    const cold = softmax([1, 2], 0.2)

    expect(cold[1]).toBeGreaterThan(warm[1])
  })
})

describe('scoreLibrary', () => {
  // The regression this module exists for: e5 cosines sit in a narrow high band,
  // so a raw softmax over many labels returned ~1/N for every book (~8% with 18
  // labels) and nothing ever cleared the 40% slider.
  test('gives a clear winner a confidence far above the uniform baseline', () => {
    // Arrange — 18 labels, cosines in the real 0.74-0.88 band.
    const labelCount = 18
    const base = Array.from({ length: labelCount }, (_, j) => 0.75 + (j % 3) * 0.01)
    const sims = [
      base.map((v, j) => (j === 2 ? 0.88 : v)),
      base.map((v, j) => (j === 5 ? 0.87 : v)),
      base.map((v, j) => (j === 2 ? 0.86 : v))
    ]

    // Act
    const scored = scoreLibrary(sims, ['', '', ''])

    // Assert
    expect(scored[0].labelIndex).toBe(2)
    expect(scored[1].labelIndex).toBe(5)
    expect(scored[0].confidence).toBeGreaterThan(0.4)
    expect(scored[0].confidence).toBeGreaterThan(4 / labelCount)
  })

  test('keeps an undecidable book below the threshold', () => {
    const flat = [Array.from({ length: 18 }, () => 0.8)]

    const [scored] = scoreLibrary(flat, [''])

    expect(scored.confidence).toBeLessThan(0.4)
  })

  test('returns a usable verdict for a single-book library', () => {
    const sims = [[0.75, 0.88, 0.77]]

    const [scored] = scoreLibrary(sims, ['Solo Author'])

    expect(scored.labelIndex).toBe(1)
    expect(Number.isFinite(scored.confidence)).toBe(true)
    expect(scored.confidence).toBeGreaterThan(1 / 3)
  })

  test('lets an author prior rescue a book its own title cannot place', () => {
    // Arrange — book 1's title is uninformative (flat row); its two siblings by
    // the same author clearly point at label 0. Books 3 and 4 exist so no label
    // is globally unloved (which centering alone would turn into a winner).
    const sims = [
      [0.9, 0.75, 0.75],
      [0.8, 0.8, 0.8],
      [0.9, 0.75, 0.75],
      [0.75, 0.75, 0.9],
      [0.75, 0.95, 0.75]
    ]
    const authors = ['Cooper', 'Cooper', 'Cooper', 'Weir', 'Other']

    // Act
    const scored = scoreLibrary(sims, authors)

    // Assert — the flat book inherits its author's genre; the others keep theirs.
    expect(scored[1].labelIndex).toBe(0)
    expect(scored[3].labelIndex).toBe(2)
    expect(scored[4].labelIndex).toBe(1)
  })

  test('scores every book exactly once', () => {
    const sims = [
      [0.8, 0.85],
      [0.9, 0.7],
      [0.75, 0.76]
    ]

    expect(scoreLibrary(sims, ['a', 'b', 'c'])).toHaveLength(3)
  })
})
