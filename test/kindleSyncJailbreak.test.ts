import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { detectJailbreak, parseJailbreakMarker } from '../src/main/kindleSync/jailbreak'

// The real file jb.sh v2.5.0 leaves on the USB partition (checked on the test Kindle).
const JBSH_MARKER = 'You are jailbroken!\n(jb.sh v2.5.0)\nhttps://kindlemodding.org\nhttps://hackerdude.tech\n\nSpiderCat Jailbreak by sparklerfish'

describe('parseJailbreakMarker', () => {
  test('recognizes jb.sh and its version', () => {
    expect(parseJailbreakMarker(JBSH_MARKER)).toEqual({ kind: 'jbsh', version: '2.5.0' })
  })

  test('a marker without the jb.sh line is a jailbreak this feature does not support', () => {
    expect(parseJailbreakMarker('You are jailbroken!\n')).toEqual({ kind: 'unsupported' })
  })
})

describe('detectJailbreak', () => {
  let mountpoint: string

  beforeEach(() => {
    mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
    mkdirSync(path.join(mountpoint, 'documents'))
  })

  afterEach(() => {
    rmSync(mountpoint, { recursive: true, force: true })
  })

  test('a Kindle without the marker is not jailbroken', async () => {
    expect(await detectJailbreak(mountpoint)).toEqual({ kind: 'none' })
  })

  test('reads the marker jb.sh leaves in documents/', async () => {
    // Arrange
    writeFileSync(path.join(mountpoint, 'documents', 'JAILBROKEN.txt'), JBSH_MARKER)

    // Act
    const result = await detectJailbreak(mountpoint)

    // Assert
    expect(result).toEqual({ kind: 'jbsh', version: '2.5.0' })
  })

  test('only the start of an oversized marker is read', async () => {
    writeFileSync(path.join(mountpoint, 'documents', 'JAILBROKEN.txt'), `${'x'.repeat(1_000_000)}(jb.sh v9.9.9)`)

    expect(await detectJailbreak(mountpoint)).toEqual({ kind: 'unsupported' })
  })

  test('a marker that is a link is not followed', async () => {
    const elsewhere = path.join(mountpoint, 'elsewhere.txt')
    writeFileSync(elsewhere, JBSH_MARKER)
    symlinkSync(elsewhere, path.join(mountpoint, 'documents', 'JAILBROKEN.txt'))

    expect(await detectJailbreak(mountpoint)).toEqual({ kind: 'none' })
  })
})
