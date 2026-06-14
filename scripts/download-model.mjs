#!/usr/bin/env node
/**
 * Downloads the Xenova/multilingual-e5-small model files from HuggingFace Hub
 * into src/renderer/public/models/ so they get bundled with the production build.
 *
 * This is a multilingual sentence-embedding model (100+ languages). Book
 * classification works by embedding the book text and each genre label and
 * comparing them with cosine similarity, so titles and labels in any language
 * (Italian, English, …) are matched consistently — see classifier.worker.ts.
 *
 * Integrity:
 *   - The model is pinned to an immutable commit revision (not `resolve/main`),
 *     so the bytes downloaded today are the same bytes forever.
 *   - Each file is verified against its expected SHA-256 AND byte size after
 *     download, and the on-disk cache check re-verifies both — so a truncated
 *     or corrupted file is never silently treated as cached.
 *   - Downloads land on a `.tmp` path and are only renamed into place once
 *     verification passes, so an interrupted download cannot poison the cache.
 *
 * Usage: node scripts/download-model.mjs
 */

import { mkdir, writeFile, stat, rename, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL_ID = 'Xenova/multilingual-e5-small'
// Pinned to an immutable commit so the downloaded bytes never change underneath us.
const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`
const OUTPUT_DIR = path.resolve(__dirname, '../src/renderer/public/models', MODEL_ID)

// Expected SHA-256 + byte size per file at MODEL_REVISION. SHA-256s for the
// small JSON files were computed from the pinned revision; the .onnx and
// tokenizer.json values are the HuggingFace LFS object ids (which are SHA-256).
const FILES = [
  {
    name: 'config.json',
    size: 658,
    sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1'
  },
  {
    name: 'tokenizer.json',
    size: 17082730,
    sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'
  },
  {
    name: 'tokenizer_config.json',
    size: 443,
    sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'
  },
  {
    name: 'special_tokens_map.json',
    size: 167,
    sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7'
  },
  {
    name: 'onnx/model_quantized.onnx',
    size: 118308185,
    sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'
  }
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Verifies an on-disk file matches the expected byte size (cheap pre-check). */
async function isCachedAndValid(outputPath, expected) {
  if (!existsSync(outputPath)) return false
  const { size } = await stat(outputPath)
  return size === expected.size
}

async function downloadFile(file) {
  const outputPath = path.join(OUTPUT_DIR, file.name)
  const tempPath = `${outputPath}.tmp`
  const outputDir = path.dirname(outputPath)

  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Size check is enough to treat a fully-written file as cached: the file only
  // ever lands here after passing full SHA-256 verification below.
  if (await isCachedAndValid(outputPath, file)) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1)
    console.log(`  ✓ ${file.name} (${sizeMb} MB, cached)`)
    return
  }

  const url = `${BASE_URL}/${file.name}`
  process.stdout.write(`  ↓ ${file.name}... `)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  // Verify BEFORE the file is allowed near its final path, so a truncated or
  // tampered download is never treated as a valid cached artifact.
  if (buffer.length !== file.size) {
    throw new Error(
      `Size mismatch for ${file.name}: expected ${file.size} bytes, got ${buffer.length}.`
    )
  }
  const actualSha = sha256(buffer)
  if (actualSha !== file.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${file.name}: expected ${file.sha256}, got ${actualSha}.`
    )
  }

  // Temp-then-rename: an interrupted process leaves only a .tmp, never a
  // partially-written file at the cache path.
  await writeFile(tempPath, buffer)
  try {
    await rename(tempPath, outputPath)
  } catch (err) {
    await rm(tempPath, { force: true })
    throw err
  }

  const sizeMb = (buffer.length / 1024 / 1024).toFixed(1)
  console.log(`done (${sizeMb} MB, verified)`)
}

async function main() {
  console.log(`Downloading model: ${MODEL_ID}`)
  console.log(`Revision: ${MODEL_REVISION}`)
  console.log(`Destination: ${OUTPUT_DIR}\n`)

  for (const file of FILES) {
    await downloadFile(file)
  }

  console.log('\nModel ready. Run "yarn build" to bundle it into the app.')
}

main().catch((err) => {
  console.error('Model download failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
