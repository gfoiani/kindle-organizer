import { describe, expect, test } from 'vitest'
import { planKindleCollections, KINDLE_COLLECTION_SEPARATOR } from '../src/main/kindleSync/plan'
import { SUBCOLLECTION_SEPARATOR } from '../src/renderer/src/utils/collectionHierarchy'

describe('planKindleCollections', () => {
  test('a top-level collection keeps its name and its books on the device', () => {
    // Arrange
    const collections = [{ name: 'Giallo', relpaths: ['A/One.azw3', 'B/Two.azw3'] }]
    const device = ['A/One.azw3', 'B/Two.azw3']

    // Act
    const plan = planKindleCollections(collections, device)

    // Assert
    expect(plan).toEqual([{ name: 'Giallo', relpaths: ['A/One.azw3', 'B/Two.azw3'] }])
  })

  test('sub-collections are merged into their top-level collection', () => {
    const collections = [
      { name: 'Giallo', relpaths: ['A/One.azw3'] },
      { name: 'Giallo / Cooper, Glenn', relpaths: ['Cooper/Three.azw3'] },
      { name: 'Giallo / Christie, Agatha', relpaths: ['Christie/Four.azw3', 'A/One.azw3'] }
    ]
    const device = ['A/One.azw3', 'Cooper/Three.azw3', 'Christie/Four.azw3']

    expect(planKindleCollections(collections, device)).toEqual([
      { name: 'Giallo', relpaths: ['A/One.azw3', 'Christie/Four.azw3', 'Cooper/Three.azw3'] }
    ])
  })

  test('a sub-collection whose parent does not exist still produces the parent on the device', () => {
    const plan = planKindleCollections([{ name: 'Viaggi / Terzani', relpaths: ['T/Book.azw3'] }], ['T/Book.azw3'])

    expect(plan).toEqual([{ name: 'Viaggi', relpaths: ['T/Book.azw3'] }])
  })

  test('books that are not on this device are left out', () => {
    const plan = planKindleCollections([{ name: 'Letti', relpaths: ['A/Here.azw3', 'A/Elsewhere.azw3'] }], ['A/Here.azw3'])

    expect(plan).toEqual([{ name: 'Letti', relpaths: ['A/Here.azw3'] }])
  })

  test('a collection with no books on this device is still planned, empty', () => {
    // The device must know it is wanted: a Kindle collection imported into the
    // app that holds only books the app cannot see (Amazon purchases) is empty
    // here, and leaving it out would make the mirror delete it. The component
    // does not CREATE an empty collection; it only keeps an existing one.
    const plan = planKindleCollections(
      [
        { name: 'Vuota', relpaths: [] },
        { name: 'Altrove', relpaths: ['X/Missing.azw3'] }
      ],
      ['A/Here.azw3']
    )

    expect(plan).toEqual([
      { name: 'Altrove', relpaths: [] },
      { name: 'Vuota', relpaths: [] }
    ])
  })

  test('relpaths match case-insensitively and across Unicode forms, keeping the device spelling', () => {
    const decomposed = 'Café/Libro.azw3'
    const plan = planKindleCollections([{ name: 'Viaggi', relpaths: ['café/libro.AZW3'] }], [decomposed])

    expect(plan).toEqual([{ name: 'Viaggi', relpaths: [decomposed] }])
  })

  test('top-level names that differ only by case or spacing become one collection named after the top-level one', () => {
    const plan = planKindleCollections(
      [
        { name: 'giallo  / Cooper', relpaths: ['C/One.azw3'] },
        { name: 'Giallo', relpaths: ['A/Two.azw3'] }
      ],
      ['C/One.azw3', 'A/Two.azw3']
    )

    expect(plan).toEqual([{ name: 'Giallo', relpaths: ['A/Two.azw3', 'C/One.azw3'] }])
  })

  test('blank names are ignored', () => {
    const plan = planKindleCollections([{ name: '   ', relpaths: ['A/One.azw3'] }], ['A/One.azw3'])

    expect(plan).toEqual([])
  })

  test('output is sorted and free of duplicates, so the same state always yields the same plan', () => {
    const collections = [
      { name: 'Zeta', relpaths: ['B.azw3', 'A.azw3', 'B.azw3'] },
      { name: 'Alfa', relpaths: ['A.azw3'] }
    ]

    const plan = planKindleCollections(collections, ['A.azw3', 'B.azw3'])

    expect(plan).toEqual([
      { name: 'Alfa', relpaths: ['A.azw3'] },
      { name: 'Zeta', relpaths: ['A.azw3', 'B.azw3'] }
    ])
  })

  test('does not mutate its inputs', () => {
    const collections = Object.freeze([Object.freeze({ name: 'Giallo', relpaths: Object.freeze(['B.azw3', 'A.azw3']) })])
    const device = Object.freeze(['A.azw3', 'B.azw3'])

    expect(() => planKindleCollections(collections, device)).not.toThrow()
    expect(collections[0].relpaths).toEqual(['B.azw3', 'A.azw3'])
  })

  test('uses the same separator as the renderer hierarchy', () => {
    expect(KINDLE_COLLECTION_SEPARATOR).toBe(SUBCOLLECTION_SEPARATOR)
  })
})
