import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { DeviceDocumentsMissingError, uploadFile } from '../src/main/deviceUpload'

let root: string
let mountpoint: string
let source: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kindle-upload-'))
  mountpoint = path.join(root, 'KINDLE')
  mkdirSync(path.join(mountpoint, 'documents'), { recursive: true })
  source = path.join(root, 'converted.azw3')
  writeFileSync(source, Buffer.alloc(4096, 0x42))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('uploadFile', () => {
  test('copies the file into documents/ and returns its relpath', async () => {
    const relpath = await uploadFile(source, mountpoint, 'My Book.azw3')

    expect(relpath).toBe('My Book.azw3')
    const dest = path.join(mountpoint, 'documents', 'My Book.azw3')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest).equals(readFileSync(source))).toBe(true)
  })

  test('reports byte progress, reaching 100%', async () => {
    const onProgress = vi.fn()

    await uploadFile(source, mountpoint, 'Book.azw3', onProgress)

    expect(onProgress).toHaveBeenCalled()
    expect(onProgress).toHaveBeenLastCalledWith(100)
  })

  test('leaves no orphaned .tmp file after a successful upload', async () => {
    await uploadFile(source, mountpoint, 'Book.azw3')
    expect(existsSync(path.join(mountpoint, 'documents', '.Book.azw3.tmp'))).toBe(false)
  })

  test('throws DeviceDocumentsMissingError when documents/ is absent', async () => {
    const noDocs = path.join(root, 'NOT_A_KINDLE')
    mkdirSync(noDocs, { recursive: true })

    await expect(uploadFile(source, noDocs, 'Book.azw3')).rejects.toBeInstanceOf(
      DeviceDocumentsMissingError
    )
  })

  test('rejects and leaves no partial file when the source does not exist', async () => {
    await expect(uploadFile(path.join(root, 'nope.azw3'), mountpoint, 'Book.azw3')).rejects.toThrow()
    expect(existsSync(path.join(mountpoint, 'documents', 'Book.azw3'))).toBe(false)
    expect(existsSync(path.join(mountpoint, 'documents', '.Book.azw3.tmp'))).toBe(false)
  })
})
