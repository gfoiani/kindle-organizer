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
 * Usage: node scripts/download-model.mjs
 */

import { mkdir, writeFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL_ID = 'Xenova/multilingual-e5-small'
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`
const OUTPUT_DIR = path.resolve(__dirname, '../src/renderer/public/models', MODEL_ID)

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx'
]

async function downloadFile(filename) {
  const outputPath = path.join(OUTPUT_DIR, filename)
  const outputDir = path.dirname(outputPath)

  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  if (existsSync(outputPath)) {
    const { size } = await stat(outputPath)
    const sizeMb = (size / 1024 / 1024).toFixed(1)
    console.log(`  ✓ ${filename} (${sizeMb} MB, cached)`)
    return
  }

  const url = `${BASE_URL}/${filename}`
  process.stdout.write(`  ↓ ${filename}... `)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(outputPath, buffer)

  const sizeMb = (buffer.length / 1024 / 1024).toFixed(1)
  console.log(`done (${sizeMb} MB)`)
}

console.log(`Downloading model: ${MODEL_ID}`)
console.log(`Destination: ${OUTPUT_DIR}\n`)

for (const file of FILES) {
  await downloadFile(file)
}

console.log('\nModel ready. Run "yarn build" to bundle it into the app.')
