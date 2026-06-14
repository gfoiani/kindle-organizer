#!/usr/bin/env tsx
/**
 * Release automation for Kindle Organizer.
 *
 * The ONLY thing the script can't know is the version you want to ship — that's
 * the single required argument. Everything else (repo owner/name, the DMG asset,
 * its SHA-256, the tap repo path) is derived automatically.
 *
 * What it does, end to end:
 *   1. Bumps package.json to <version>, commits it, creates tag v<version>, pushes.
 *      → this triggers .github/workflows/build.yml, which builds the DMG/EXE and
 *        publishes a GitHub Release.
 *   2. Waits for that release's macOS .dmg asset to appear, downloads it,
 *      computes its SHA-256, and writes version + sha256 into the Homebrew tap
 *      cask (../homebrew/Casks/kindle-organizer.rb).
 *   3. Commits and pushes the tap repo.
 *
 * Usage:
 *   yarn release <version>                 # full flow (bump → tag → push → wait → tap)
 *   yarn release <version> --no-homebrew   # stop after the tag/push (CI only)
 *   yarn release <version> --homebrew-only # skip the bump/tag; just update the tap
 *   yarn release <version> --dmg <path>    # use a local DMG instead of downloading
 *   yarn release <version> --sha <hash>    # use this SHA-256 directly (no download)
 *   yarn release <version> --no-wait       # don't poll; fail fast if release isn't ready
 *   yarn release <version> --no-push       # do everything except git push
 *   yarn release <version> --tap <dir>     # tap repo dir (default $HOMEBREW_DIR or ../homebrew)
 *   yarn release <version> --allow-dirty   # proceed even with other uncommitted changes
 *
 * Downloading from a private repo needs a token: set GITHUB_TOKEN or GH_TOKEN
 * (in .env or the environment). With --dmg or --sha no token is required.
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import * as dotenv from 'dotenv'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')

// ─── Arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const positional: string[] = []
const flags = new Map<string, string | boolean>()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  } else {
    positional.push(a)
  }
}

const version = positional[0]
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
if (!version || !SEMVER.test(version)) {
  console.error('Error: a valid <version> (e.g. 0.1.3) is required.')
  console.error('Usage: yarn release <version> [--no-homebrew] [--homebrew-only] [--dmg <path>] [--sha <hash>] [--no-wait] [--no-push] [--tap <dir>] [--allow-dirty]')
  process.exit(1)
}

const tag = `v${version}`
const doPush = !flags.has('no-push')
const homebrewOnly = flags.has('homebrew-only')
const skipHomebrew = flags.has('no-homebrew')
const noWait = flags.has('no-wait')
const allowDirty = flags.has('allow-dirty')
const dmgArg = typeof flags.get('dmg') === 'string' ? (flags.get('dmg') as string) : undefined
const shaArg = typeof flags.get('sha') === 'string' ? (flags.get('sha') as string) : undefined
const tapDir = resolve(
  appRoot,
  (typeof flags.get('tap') === 'string' ? (flags.get('tap') as string) : undefined) ||
    process.env.HOMEBREW_DIR ||
    '../homebrew'
)
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd: string, cwd: string = appRoot): string {
  console.log(`$ ${cmd}`)
  return execSync(cmd, { cwd, stdio: ['inherit', 'pipe', 'inherit'] }).toString().trim()
}

function tryRun(cmd: string, cwd: string = appRoot): string | null {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Parses owner/repo from the app repo's origin remote. */
function getOwnerRepo(): { owner: string; repo: string } {
  const url = run('git remote get-url origin')
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  if (!m) throw new Error(`Could not parse owner/repo from origin remote: ${url}`)
  return { owner: m[1], repo: m[2] }
}

interface ReleaseAsset {
  name: string
  url: string
  browser_download_url: string
}

async function fetchRelease(
  owner: string,
  repo: string
): Promise<{ assets: ReleaseAsset[] } | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kindle-organizer-release',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`)
  return res.json() as Promise<{ assets: ReleaseAsset[] }>
}

/** Polls the release until its .dmg asset is available, downloads it, returns the local path. */
async function downloadReleaseDmg(owner: string, repo: string): Promise<string> {
  if (!token) {
    throw new Error(
      'No GITHUB_TOKEN/GH_TOKEN set — cannot download the release asset from a private repo.\n' +
        'Set a token, or re-run with --dmg <path> (downloaded DMG) or --sha <hash>.'
    )
  }

  const TIMEOUT_MS = 20 * 60_000
  const INTERVAL_MS = 30_000
  const deadline = Date.now() + TIMEOUT_MS

  for (;;) {
    const release = await fetchRelease(owner, repo)
    const asset = release?.assets.find((a) => a.name.toLowerCase().endsWith('.dmg'))
    if (asset) {
      console.log(`Downloading release asset: ${asset.name}`)
      const res = await fetch(asset.url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'kindle-organizer-release',
          Authorization: `Bearer ${token}`
        }
      })
      if (!res.ok) throw new Error(`Asset download failed: ${res.status} ${res.statusText}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const out = join(tmpdir(), asset.name)
      await writeFile(out, buf)
      console.log(`Saved to ${out} (${(buf.length / 1048576).toFixed(1)} MB)`)
      return out
    }

    if (noWait) throw new Error(`Release ${tag} has no .dmg asset yet (CI still building?). Re-run later.`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${tag}'s .dmg asset.`)
    console.log(`Release ${tag} not ready yet — retrying in ${INTERVAL_MS / 1000}s…`)
    await delay(INTERVAL_MS)
  }
}

/** Writes version + sha256 into the tap cask (when a SHA is supplied directly). */
function writeCask(sha: string): void {
  const caskFile = join(tapDir, 'Casks', 'kindle-organizer.rb')
  if (!existsSync(caskFile)) throw new Error(`Cask not found: ${caskFile}`)
  let content = readFileSync(caskFile, 'utf-8')
  content = content.replace(/^[ \t]*version.*/m, `  version "${version}"`)
  content = content.replace(/^[ \t]*sha256.*/m, `  sha256 "${sha}"`)
  writeFileSync(caskFile, content)
  console.log(`Updated ${caskFile}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Phase 1 — bump, commit, tag, push (unless --homebrew-only)
  if (!homebrewOnly) {
    // Refuse to release on a dirty tree (other than package.json) unless allowed.
    const dirty = run('git status --porcelain')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.endsWith('package.json'))
    if (dirty.length > 0 && !allowDirty) {
      console.error('Error: working tree has uncommitted changes. Commit/stash them first, or pass --allow-dirty.')
      console.error(dirty.join('\n'))
      process.exit(1)
    }

    if (tryRun(`git rev-parse ${tag}`)) {
      console.error(`Error: tag ${tag} already exists.`)
      process.exit(1)
    }

    const pkgPath = join(appRoot, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (pkg.version !== version) {
      pkg.version = version
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
      run('git add package.json')
      run(`git commit -m "chore: release ${tag}"`)
    } else {
      console.log(`package.json already at ${version} — skipping bump/commit.`)
    }

    run(`git tag ${tag}`)
    if (doPush) {
      run('git push origin HEAD')
      run(`git push origin ${tag}`)
      console.log(`\nPushed ${tag}. CI is now building the release…`)
    } else {
      console.log(`\nCreated tag ${tag} locally (--no-push). Push it to trigger CI.`)
    }
  }

  if (skipHomebrew) {
    console.log('Done (--no-homebrew): skipped the Homebrew tap update.')
    return
  }
  if (!doPush && !homebrewOnly && !dmgArg && !shaArg) {
    console.log('Skipping Homebrew update: nothing was pushed, so there is no release to fetch.')
    return
  }

  // Phase 2 — update the Homebrew tap cask with the released DMG's SHA-256
  console.log('\nUpdating the Homebrew tap…')
  if (shaArg) {
    writeCask(shaArg)
  } else {
    let dmgPath = dmgArg
    if (!dmgPath) {
      const { owner, repo } = getOwnerRepo()
      dmgPath = await downloadReleaseDmg(owner, repo)
    }
    // Reuse update-homebrew.mts: it reads the version from package.json,
    // computes the SHA-256, and writes both into the tap cask.
    run(`yarn update-homebrew "${dmgPath}" "${tapDir}"`)
  }

  // Commit & push the tap repo (separate from the app repo)
  run('git add Casks/kindle-organizer.rb', tapDir)
  run(`git commit -m "kindle-organizer ${version}"`, tapDir)
  if (doPush) run('git push', tapDir)

  console.log(`\n✅ Released ${tag} and updated the Homebrew tap.`)
  console.log('Users upgrade with: brew update && brew upgrade --cask kindle-organizer')
}

main().catch((err) => {
  console.error('\nRelease failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
