import { defineConfig } from 'vitest/config'

// Main-process logic runs under Node; the renderer is exercised via E2E later.
// `electron` is unavailable in Vitest, so test/setup/electron-mock.ts stubs the
// `app` module before any src/main module is imported.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup/electron-mock.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts'],
      reporter: ['text', 'text-summary']
    }
  }
})
