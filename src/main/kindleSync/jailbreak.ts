import { promises as fs } from 'fs'
import path from 'path'

/**
 * Whether a Kindle runs the jailbreak this feature supports.
 *
 * Collection sync relies on jb.sh / KindleModding's `emergency.sh` boot hook to
 * install its component, so only that setup is accepted. jb.sh leaves
 * `documents/JAILBROKEN.txt` on the USB partition, e.g.
 *
 *     You are jailbroken!
 *     (jb.sh v2.5.0)
 *
 * A marker without the jb.sh line is another jailbreak: reported, not supported.
 */

export type JailbreakState = { kind: 'none' } | { kind: 'unsupported' } | { kind: 'jbsh'; version: string }

const MARKER_FILE = 'JAILBROKEN.txt'
/** The real marker is ~150 bytes; nothing past this is read. */
const MAX_MARKER_BYTES = 4096
const JBSH_LINE = /\(jb\.sh v(\d{1,4}\.\d{1,4}\.\d{1,4})\)/

export function parseJailbreakMarker(text: string): JailbreakState {
  const match = JBSH_LINE.exec(text)
  return match ? { kind: 'jbsh', version: match[1] } : { kind: 'unsupported' }
}

async function readHead(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_MARKER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_MARKER_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function detectJailbreak(mountpoint: string): Promise<JailbreakState> {
  const marker = path.join(mountpoint, 'documents', MARKER_FILE)
  try {
    // A link could point anywhere on the host: only a plain file counts.
    const stat = await fs.lstat(marker)
    if (!stat.isFile()) return { kind: 'none' }
    return parseJailbreakMarker(await readHead(marker))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[kindleSync] cannot read the jailbreak marker:', err instanceof Error ? err.message : String(err))
    }
    return { kind: 'none' }
  }
}
