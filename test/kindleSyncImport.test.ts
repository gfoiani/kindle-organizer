import { describe, expect, test } from 'vitest'
import { planKindleImport } from '../src/main/kindleSync/importPlan'
import type { DeviceExport } from '../src/main/kindleSync/syncFiles'

function exported(collections: DeviceExport['collections']): DeviceExport {
  return { schema: 1, collections }
}

describe('planKindleImport (first sync: Kindle collections → app collections)', () => {
  test('each Kindle collection becomes an app collection holding its books, spelled as the app keys them', () => {
    // Arrange
    const kindle = exported([{ name: 'Letti', members: ['dan brown/inferno.azw3'], otherMembers: 0 }])

    // Act
    const plan = planKindleImport(kindle, ['Dan Brown/Inferno.azw3'], [])

    // Assert
    expect(plan).toEqual([{ name: 'Letti', relpaths: ['Dan Brown/Inferno.azw3'] }])
  })

  test('members the app does not list on the device are left out', () => {
    const kindle = exported([{ name: 'Letti', members: ['A.azw3', 'Gone.azw3'], otherMembers: 0 }])

    expect(planKindleImport(kindle, ['A.azw3'], [])).toEqual([{ name: 'Letti', relpaths: ['A.azw3'] }])
  })

  test('a collection holding only books the app cannot see is still imported, empty', () => {
    const kindle = exported([{ name: 'Acquisti Amazon', members: [], otherMembers: 12 }])

    expect(planKindleImport(kindle, ['A.azw3'], [])).toEqual([{ name: 'Acquisti Amazon', relpaths: [] }])
  })

  test('the sub-collection separator in a Kindle name is replaced, so it stays a plain collection', () => {
    const kindle = exported([{ name: 'Giallo / Nordico', members: [], otherMembers: 1 }])

    expect(planKindleImport(kindle, [], [])).toEqual([{ name: 'Giallo - Nordico', relpaths: [] }])
  })

  test('a name matching an existing app collection, ignoring case, joins that collection', () => {
    const kindle = exported([{ name: 'prossime letture', members: ['A.azw3'], otherMembers: 0 }])

    expect(planKindleImport(kindle, ['A.azw3'], ['Prossime letture'])).toEqual([
      { name: 'Prossime letture', relpaths: ['A.azw3'] }
    ])
  })

  test('Kindle names that differ only by case or spacing are merged', () => {
    const kindle = exported([
      { name: 'Letti', members: ['A.azw3'], otherMembers: 0 },
      { name: '  letti ', members: ['B.azw3'], otherMembers: 0 }
    ])

    expect(planKindleImport(kindle, ['A.azw3', 'B.azw3'], [])).toEqual([{ name: 'Letti', relpaths: ['A.azw3', 'B.azw3'] }])
  })

  test('blank names are skipped', () => {
    const kindle = exported([{ name: '   ', members: ['A.azw3'], otherMembers: 0 }])

    expect(planKindleImport(kindle, ['A.azw3'], [])).toEqual([])
  })
})
