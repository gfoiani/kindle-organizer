import * as fs from 'fs-extra'
import { createReadStream, createWriteStream } from 'fs'
import path from 'path'

/** The device has no documents/ folder (not a Kindle, or unplugged mid-operation). */
export class DeviceDocumentsMissingError extends Error {
  constructor(mountpoint: string) {
    super(`No documents/ folder found at ${mountpoint}`)
    this.name = 'DeviceDocumentsMissingError'
  }
}

/**
 * Copies a local file into the device's `documents/` folder atomically: it
 * streams to a hidden `.<name>.tmp` staged ON THE DEVICE (same filesystem, so
 * the final rename can't hit EXDEV) then renames it into place. An interrupted
 * upload (e.g. the Kindle is unplugged) leaves no partial visible file — the
 * temp is best-effort removed. Async streaming keeps multi-MB copies off the
 * main thread. Returns the device-relative path (flat layout → just the filename).
 */
export async function uploadFile(
  source: string,
  mountpoint: string,
  targetFilename: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const documentsDir = path.join(mountpoint, 'documents')
  if (!(await fs.pathExists(documentsDir))) {
    throw new DeviceDocumentsMissingError(mountpoint)
  }

  const finalPath = path.join(documentsDir, targetFilename)
  const tempPath = path.join(documentsDir, `.${targetFilename}.tmp`)
  const total = (await fs.stat(source)).size

  try {
    await streamCopy(source, tempPath, total, onProgress)
    await fs.rename(tempPath, finalPath)
    return targetFilename
  } catch (err) {
    // Best-effort cleanup so an interrupted upload leaves no stale `.tmp`.
    try {
      await fs.remove(tempPath)
    } catch (cleanupErr) {
      console.error(
        `[upload] Failed to clean up temp file ${tempPath}:`,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      )
    }
    throw err
  }
}

function streamCopy(
  source: string,
  dest: string,
  total: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = createReadStream(source)
    const write = createWriteStream(dest)
    let copied = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      read.destroy()
      write.destroy()
      reject(err)
    }

    read.on('data', (chunk: string | Buffer) => {
      copied += chunk.length
      if (onProgress && total > 0) {
        onProgress(Math.min(100, Math.round((copied / total) * 100)))
      }
    })
    read.on('error', fail)
    write.on('error', fail)
    write.on('finish', () => {
      if (!settled) {
        settled = true
        resolve()
      }
    })

    read.pipe(write)
  })
}
