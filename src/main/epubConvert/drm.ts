import type { EpubArchive } from './archive'
import { findAllByName, parseXml } from './dom'
import { EpubDrmError } from './errors'

const ENCRYPTION_PATH = 'META-INF/encryption.xml'
/** Adobe ADEPT ships its licence here; its presence alone means DRM. */
const RIGHTS_PATH = 'META-INF/rights.xml'
/**
 * Font obfuscation (IDPF and Adobe) is not DRM: it scrambles embedded fonts
 * only, and the converter drops embedded fonts anyway.
 */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'])

/** Throws EpubDrmError when the book's content is encrypted. */
export async function assertNotDrmProtected(archive: EpubArchive): Promise<void> {
  if (archive.has(RIGHTS_PATH)) throw new EpubDrmError()
  if (!archive.has(ENCRYPTION_PATH)) return

  const doc = parseXml((await archive.read(ENCRYPTION_PATH)).toString('utf-8'))
  const algorithms = findAllByName(doc, 'encryptionmethod').map((m) => m.attribs.Algorithm ?? '')
  if (algorithms.some((a) => !FONT_OBFUSCATION.has(a))) throw new EpubDrmError()
}
