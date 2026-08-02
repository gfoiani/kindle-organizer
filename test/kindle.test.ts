import { afterAll, describe, expect, test } from 'vitest'
import * as fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { readDocuments } from '../src/main/kindle'

// A real temp directory rather than a mocked fs: the behaviour under test is
// precisely what the filesystem hands back, which a mock would have to fake.
const tempRoots: string[] = []

async function fakeDevice(filenames: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-scan-'))
  tempRoots.push(root)
  const documents = path.join(root, 'documents')
  await fs.ensureDir(documents)
  for (const name of filenames) await fs.writeFile(path.join(documents, name), '')
  return root
}

afterAll(async () => {
  for (const root of tempRoots) await fs.remove(root)
})

describe('readDocuments', () => {
  test('derives composed (NFC) titles from decomposed (NFD) filenames', async () => {
    const composed = 'Non è ciò che volevo'
    const root = await fakeDevice([`${composed.normalize('NFD')}.azw3`])

    const books = await readDocuments(root)

    expect(books).toHaveLength(1)
    // The title is an identity/display string: it must match the composed form
    // that EPUB metadata and the staging library use, or an uploaded book never
    // reconciles with its device copy and accented searches miss it.
    expect(books[0].title).toBe(composed.normalize('NFC'))
  })

  test('keeps the path exactly as the filesystem returned it, so the file still opens', async () => {
    const root = await fakeDevice(['Non è ciò che volevo'.normalize('NFD') + '.azw3'])

    const books = await readDocuments(root)

    await expect(fs.pathExists(books[0].path)).resolves.toBe(true)
  })

  test('composes accented author folder names too', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-scan-'))
    tempRoots.push(root)
    const author = 'Fabbri, Niccolò'
    const authorDir = path.join(root, 'documents', author.normalize('NFD'))
    await fs.ensureDir(authorDir)
    await fs.writeFile(path.join(authorDir, 'Qualcosa.azw3'), '')

    const books = await readDocuments(root)

    expect(books).toHaveLength(1)
    expect(books[0].author).toBe(author.normalize('NFC'))
  })
})
