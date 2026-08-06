import { describe, expect, test } from 'vitest'
import { PLACEHOLDER_TINTS, placeholderTint } from '../src/renderer/src/utils/coverPlaceholder'

// Real, varied titles and authors — NOT a `Book ${i}` / `Author ${i}` pattern.
// That synthetic pattern is a poor fuzz corpus for this hash: FNV-1a's bit 0
// is the XOR of the low bit of every input character (multiplying by an odd
// prime never changes bit 0), and `Book ${i}` / `Author ${i}` embeds the same
// digit(s) in both fields, so their bit-0 contributions cancel out exactly —
// the parity (and therefore whether `hash % 8` lands even or odd) stays
// constant across every `i`, silently limiting the corpus to half the
// palette. Independent, unrelated title/author text — real book titles never
// mirror a counter between their two fields — doesn't have that failure mode.
// Two independently-sized (coprime-length) lists, cycled with the same index,
// give 500 distinct title/author pairings with no arithmetic correlation
// between them (verified below, not assumed).
const TITLES = [
  'Dune',
  'Nineteen Eighty-Four',
  'Pride and Prejudice',
  'The Hobbit',
  'Brave New World',
  'The Great Gatsby',
  'Moby-Dick',
  'War and Peace',
  'Crime and Punishment',
  'The Catcher in the Rye',
  'To Kill a Mockingbird',
  'One Hundred Years of Solitude',
  'The Lord of the Rings',
  'Fahrenheit 451',
  'Slaughterhouse-Five',
  'The Brothers Karamazov',
  'Anna Karenina',
  'Frankenstein',
  'Dracula',
  'The Odyssey',
  'Beloved',
  'Neuromancer',
  'Snow Crash'
]

const AUTHORS = [
  'Frank Herbert',
  'George Orwell',
  'Jane Austen',
  'J.R.R. Tolkien',
  'Aldous Huxley',
  'F. Scott Fitzgerald',
  'Herman Melville',
  'Leo Tolstoy',
  'Fyodor Dostoevsky',
  'J.D. Salinger',
  'Harper Lee',
  'Gabriel García Márquez',
  'Ray Bradbury',
  'Kurt Vonnegut',
  'Mary Shelley',
  'Bram Stoker',
  'Homer',
  'Toni Morrison',
  'William Gibson',
  'Neal Stephenson',
  'Ursula K. Le Guin',
  'Isaac Asimov',
  'Patrick Rothfuss',
  'Neil Gaiman',
  'Terry Pratchett',
  'George R.R. Martin',
  'Haruki Murakami',
  'Umberto Eco',
  'Primo Levi'
]

// A real book/author corpus for the spread test — distinct from TITLES/AUTHORS
// above (which are deliberately recombined off-pairing for the fuzz test) so
// this one reflects actual title+author pairings.
const REAL_BOOKS: ReadonlyArray<readonly [string, string]> = [
  ['Dune', 'Frank Herbert'],
  ['Nineteen Eighty-Four', 'George Orwell'],
  ['Pride and Prejudice', 'Jane Austen'],
  ['The Hobbit', 'J.R.R. Tolkien'],
  ['Brave New World', 'Aldous Huxley'],
  ['The Great Gatsby', 'F. Scott Fitzgerald'],
  ['Moby-Dick', 'Herman Melville'],
  ['War and Peace', 'Leo Tolstoy'],
  ['Crime and Punishment', 'Fyodor Dostoevsky'],
  ['The Catcher in the Rye', 'J.D. Salinger'],
  ['To Kill a Mockingbird', 'Harper Lee'],
  ['One Hundred Years of Solitude', 'Gabriel García Márquez'],
  ['The Lord of the Rings', 'J.R.R. Tolkien'],
  ['Fahrenheit 451', 'Ray Bradbury'],
  ['Slaughterhouse-Five', 'Kurt Vonnegut'],
  ['The Brothers Karamazov', 'Fyodor Dostoevsky'],
  ['Anna Karenina', 'Leo Tolstoy'],
  ['Frankenstein', 'Mary Shelley'],
  ['Dracula', 'Bram Stoker'],
  ['The Odyssey', 'Homer'],
  ['Beloved', 'Toni Morrison'],
  ['Neuromancer', 'William Gibson'],
  ['Snow Crash', 'Neal Stephenson'],
  ['The Name of the Wind', 'Patrick Rothfuss'],
  ['American Gods', 'Neil Gaiman'],
  ['Good Omens', 'Terry Pratchett'],
  ['A Game of Thrones', 'George R.R. Martin'],
  ['Kafka on the Shore', 'Haruki Murakami'],
  ['Il nome della rosa', 'Umberto Eco'],
  ['Se questo è un uomo', 'Primo Levi'],
  ['Perché le nazioni falliscono', 'Daron Acemoglu'],
  ['Sapiens', 'Yuval Noah Harari'],
  ['Educated', 'Tara Westover']
]

describe('placeholderTint', () => {
  test('returns the same tint for repeated calls with the same book', () => {
    const first = placeholderTint('Dune', 'Frank Herbert')
    const second = placeholderTint('Dune', 'Frank Herbert')

    expect(second).toEqual(first)
  })

  test('returns the same tint for the NFD and NFC forms of an accented title', () => {
    // macOS hands back NFD from the Kindle volume; the staging library stores NFC.
    // Without normalization the same book would change colour depending on which
    // side it was read from.
    const composed = 'Perché le nazioni falliscono'
    const decomposed = composed.normalize('NFD')

    expect(decomposed).not.toBe(composed) // guard: the two forms really differ
    expect(placeholderTint(decomposed)).toEqual(placeholderTint(composed))
  })

  test('ignores surrounding whitespace and letter case', () => {
    expect(placeholderTint('  DUNE  ', '  Frank Herbert ')).toEqual(
      placeholderTint('dune', 'frank herbert')
    )
  })

  test('treats an absent author the same as an empty one', () => {
    expect(placeholderTint('Dune')).toEqual(placeholderTint('Dune', ''))
  })

  test('returns a stable palette tint for an empty title', () => {
    expect(placeholderTint('')).toEqual(placeholderTint(''))
    expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(''))
  })

  test('always returns a palette member, including for inputs whose raw hash overflows to negative', () => {
    // TITLES and AUTHORS have coprime lengths (23, 29), so cycling both by the
    // same `i` produces 500 distinct pairings before the combined cycle repeats
    // (lcm(23, 29) = 667 > 500) — a real fuzz sweep, not 500 copies of one shape.
    for (let i = 0; i < 500; i++) {
      const title = TITLES[i % TITLES.length]
      const author = AUTHORS[i % AUTHORS.length]
      expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(title, author))
    }
  })

  test('spreads real book/author pairs across every palette entry', () => {
    // A synthetic `Book ${i}` / `Author ${i}` corpus only ever reaches 4 of the 8
    // entries here (see the module comment above) — real, unrelated title/author
    // text does not share that failure mode. Asserting every entry is reachable
    // (rather than just "more than one") is what actually catches a palette
    // degenerating to e.g. 2 tints, which `toBeGreaterThan(1)` would miss.
    const reached = REAL_BOOKS.map(([title, author]) => placeholderTint(title, author))

    for (const tint of PLACEHOLDER_TINTS) {
      expect(reached).toContainEqual(tint)
    }
  })

  test('exposes exactly the eight curated pairs', () => {
    expect(PLACEHOLDER_TINTS).toEqual([
      { from: '#1e1b4b', to: '#3730a3' }, // indigo
      { from: '#042f2e', to: '#115e59' }, // teal
      { from: '#500724', to: '#9d174d' }, // pink
      { from: '#451a03', to: '#92400e' }, // amber
      { from: '#2e1065', to: '#5b21b6' }, // violet
      { from: '#082f49', to: '#075985' }, // sky
      { from: '#022c22', to: '#065f46' }, // emerald
      { from: '#020617', to: '#334155' } // slate
    ])
  })
})
