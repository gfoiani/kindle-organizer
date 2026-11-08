// Builds the Kindle sync component (component/, Go) for the Kindle's ARM CPU:
// one static binary, the same whichever OS builds it, bundled into the app as
// resources/kindle-sync/kosync (package.json "extraResources").
//
// A Node script rather than an inline `GOOS=… go build`, which cmd.exe (yarn on
// Windows) cannot run.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const componentDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'component')
const output = path.join('dist', 'kosync-linux-armv7')

const result = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, './cmd/kosync'], {
  cwd: componentDir,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'arm', GOARM: '7' }
})

if (result.error) {
  console.error(`[build:component] Could not run Go (${result.error.message}). Install Go 1.26: https://go.dev/dl/`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[build:component] go build failed (exit ${result.status})`)
  process.exit(result.status ?? 1)
}
console.error(`[build:component] ${path.join('component', output)}`)
