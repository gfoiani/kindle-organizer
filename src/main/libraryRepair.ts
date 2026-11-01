import { parseEpub } from './epub'
import { isRegularFileInside } from './folderScan'
import {
  getLibraryFolder,
  getMetadataReaderVersion,
  listLibraryBooks,
  setLibraryBookAuthor,
  setMetadataReaderVersion,
  type LibraryBook
} from './library'

/**
 * Bumped whenever the EPUB metadata reader learns to read something it used to
 * miss, so the rows an older reader filled in are read again, once.
 *  1 — Dublin Core without the `dc:` prefix (`<creator xmlns="…dc…">`), whose
 *      author used to be lost: the book was recorded as "Unknown" on the device.
 */
export const METADATA_READER_VERSION = 1

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The author the current reader finds in a book's EPUB; undefined when it
 * names none. Throws when the file cannot be read. A folder book's file belongs
 * to the user and must still be a regular file inside its folder.
 */
async function readAuthor(book: LibraryBook): Promise<string | undefined> {
  if (book.folderId) {
    const folder = getLibraryFolder(book.folderId)
    if (!folder || !(await isRegularFileInside(folder.path, book.originalPath))) {
      throw new Error('the file is no longer inside its library folder')
    }
  }
  return (await parseEpub(book.originalPath)).author
}

/**
 * Re-reads the EPUBs in the library that have no author, once per reader
 * version, and returns how many gained one. Run at startup. A file that cannot
 * be read (a library folder on an unplugged disk) leaves the version unchanged,
 * so the next start tries again.
 */
export async function repairLibraryMetadata(): Promise<number> {
  if (getMetadataReaderVersion() >= METADATA_READER_VERSION) return 0

  const authorless = listLibraryBooks().filter((book) => book.sourceFormat === 'epub' && !book.author)
  let repaired = 0
  let complete = true
  for (const book of authorless) {
    try {
      const author = await readAuthor(book)
      if (author) {
        setLibraryBookAuthor(book.id, author)
        repaired++
      }
    } catch (err) {
      complete = false
      console.error(`[library] Could not re-read the metadata of "${book.title}":`, errorText(err))
    }
  }

  if (complete) setMetadataReaderVersion(METADATA_READER_VERSION)
  return repaired
}
