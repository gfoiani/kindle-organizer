#!/usr/bin/env node
/**
 * Downloads the Xenova/mobilebert-uncased-mnli model files from HuggingFace Hub
 * into src/renderer/public/models/ so they get bundled with the production build.
 *
 * Usage: node scripts/download-model.mjs
 */

import { mkdir, writeFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL_ID = 'Xenova/mobilebert-uncased-mnli'
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`
const OUTPUT_DIR = path.resolve(__dirname, '../src/renderer/public/models', MODEL_ID)

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
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

console.log('\nModel ready. Run "npm run build" to bundle it into the app.')
