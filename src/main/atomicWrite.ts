import * as fs from 'fs-extra'

/**
 * Temp file then rename, so a crash, a cancellation or a Kindle unplugged
 * mid-write never leaves a truncated file behind. The temp file sits next to
 * the target (same volume, so the rename cannot hit EXDEV) and is removed when
 * the write fails; the original error is re-thrown.
 */
export async function writeFileAtomically(target: string, data: string | Buffer): Promise<void> {
  const temp = `${target}.tmp`
  try {
    await fs.writeFile(temp, data)
    await fs.rename(temp, target)
  } catch (err) {
    await fs.remove(temp).catch((cleanupErr: unknown) =>
      console.error(`[atomicWrite] Failed to clean up ${temp}:`, cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr))
    )
    throw err
  }
}
