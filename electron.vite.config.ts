import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { normalizePath } from 'vite'
import path from 'path'

export default defineConfig({
  main: {
    entry: 'src/main/index.ts',
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'fs-extra', 'systeminformation']
      }
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    entry: 'src/preload/index.ts',
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      viteStaticCopy({
        targets: [
          {
            // Copy the ONNX Runtime WASM binaries next to the worker bundle.
            // normalizePath is required: on Windows path.resolve yields backslashes,
            // which fast-glob (used by vite-plugin-static-copy) treats as escapes →
            // "No file was found to copy" and the NSIS build fails.
            src: normalizePath(path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/*.wasm')),
            dest: 'assets'
          }
        ]
      })
    ],
    optimizeDeps: {
      // ort.min.js is a UMD bundle — must be pre-bundled by esbuild so it gets
      // converted to proper ESM exports. Without this, `import * as ONNX_WEB`
      // returns an empty namespace and InferenceSession is undefined.
      include: ['onnxruntime-web'],
      exclude: ['@xenova/transformers', 'onnxruntime-common', 'onnxruntime-node']
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer/src'),
        // ort-web.min.js (the package's "browser" entry) has an external
        // require("onnxruntime-common") that breaks in Vite's CJS→ESM transform.
        // ort.min.js is the self-contained bundle with onnxruntime-common included.
        'onnxruntime-web': path.resolve(
          __dirname,
          'node_modules/onnxruntime-web/dist/ort.min.js'
        )
      }
    }
  }
})
