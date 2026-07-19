# Releasing Kindle Organizer

End-to-end procedure for shipping a new version. Most of it is automated by
[`scripts/release.mts`](scripts/release.mts) (`yarn release`); this document is the
human-facing runbook around it, including the two steps the script does **not**
do for you: updating the changelog and confirming the site.

## How a release fits together

```
   develop (all work)                              this repo (app, PUBLIC)
        │
        │  bump + tag vX.Y.Z ──push──▶ GitHub Actions (build.yml)
        │                                   │ validate → build mac/win/linux
        │                                   ▼
        │                            GitHub Release  ◀── assets: .dmg .exe .AppImage
        │                                   │
        │                                   ├──▶ Landing site (kindle-organizer-site)
        │                                   │     main.js fetches /releases/latest at
        │                                   │     page load → buttons + version update
        │                                   │     AUTOMATICALLY. No code change needed.
        │                                   │
        └── release.mts waits for the .dmg, computes its SHA-256, writes it into
            the Homebrew tap cask (../homebrew) and pushes it.
```

Three repositories are involved, checked out as siblings:

| Repo | Local path | Role |
| --- | --- | --- |
| `gfoiani/kindle-organizer` | `./` (this repo) | the app + CI that builds and publishes the GitHub Release |
| `gfoiani/homebrew-kindle-organizer` | `../homebrew` | Homebrew tap; the cask `Casks/kindle-organizer.rb` |
| `gfoiani/kindle-organizer-site` | `../site` | landing page on GitHub Pages (`https://gfoiani.github.io/kindle-organizer-site/`) |

**The site needs no per-release change.** `../site/main.js` calls the public
GitHub API for `releases/latest` on every page load and fills in the download
buttons, asset sizes and version badge. It works because the app repo is
**public**; if the repo ever goes private the buttons fall back to the releases
page. Only touch the site for design/content changes (e.g. adding a screenshot).

## Prerequisites (once)

- **Node 24** — always `nvm use` before any `yarn` command (`.nvmrc` pins 24; CI uses 22, both LTS are supported). `yarn` refuses to run on an out-of-range Node.
- **Sibling tap repo** at `../homebrew` (or set `HOMEBREW_DIR` / pass `--tap <dir>`).
- **`GITHUB_TOKEN`** in `.env` — optional while the app repo is public (the release
  asset is downloaded unauthenticated). Required only if the repo is private.
- A clean `develop` working tree.

## Steps

### 1. Validate locally (do NOT skip)

The CI runs `type-check` + `test` before it builds. If they fail, the release is
never created and `yarn release` will wait, then time out — after the tag is
already public. Catch it here first.

```bash
nvm use
yarn type-check
# Vitest runs under Node, but postinstall built better-sqlite3 for Electron's ABI.
# Rebuild it for the Node ABI first (mirrors what CI does), or the DB tests fail
# with a NODE_MODULE_VERSION mismatch:
npm rebuild better-sqlite3 --build-from-source
yarn test
```

After the release is done, restore the Electron ABI for local `yarn dev`:

```bash
yarn rebuild
```

### 2. Choose the version

Semver. New backward-compatible features → **minor** (e.g. `0.2.0 → 0.3.0`);
bug-fix-only → **patch**. The current published version is the `version` field in
`package.json` and the latest GitHub release tag.

### 3. Update the changelog

Edit [`CHANGELOG.md`](CHANGELOG.md): add a `## [X.Y.Z] - YYYY-MM-DD` section at the
top (newest first), grouped into Added / Changed / Fixed. Derive it from the
commits since the last tag:

```bash
git log --format='%s' vLAST..develop
```

### 4. Commit the changelog + docs

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for vX.Y.Z"
```

`release.mts` refuses to run on a dirty tree (other than `package.json`), so
commit everything except the version bump — the script owns that.

### 5. Run the automated release

```bash
yarn release X.Y.Z
```

This, end to end:

1. Bumps `package.json` to `X.Y.Z`, commits `chore: release vX.Y.Z`, creates tag
   `vX.Y.Z`, pushes the branch + tag → triggers `build.yml`.
2. Polls the GitHub Release until the macOS `.dmg` asset appears (up to ~20 min),
   downloads it, computes its SHA-256.
3. Writes `version` + `sha256` into `../homebrew/Casks/kindle-organizer.rb`,
   commits (`kindle-organizer X.Y.Z`) and pushes the tap.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--no-homebrew` | stop after the tag/push (let CI build; skip the tap update) |
| `--homebrew-only` | skip bump/tag; just refresh the tap (recovery) |
| `--dmg <path>` | use a local DMG instead of downloading |
| `--sha <hash>` | use this SHA-256 directly (no download) |
| `--no-wait` | fail fast if the release isn't ready yet |
| `--no-push` | do everything except `git push` (dry run) |

### 6. Sync `main` to the release

All work happens on `develop`; `main` is the released state. After the release
commit lands, fast-forward `main`:

```bash
git checkout main
git merge --ff-only develop
git push origin main
git checkout develop
```

### 7. Verify

```bash
# Latest release now points at the new tag:
curl -s https://api.github.com/repos/gfoiani/kindle-organizer/releases/latest | grep tag_name
# Homebrew tap cask updated:
grep -E 'version|sha256' ../homebrew/Casks/kindle-organizer.rb
```

- Open `https://gfoiani.github.io/kindle-organizer-site/` — the version badge and
  download buttons should show the new version (may lag a minute; hard-refresh).
- Upgrade path for users: `brew update && brew upgrade --cask kindle-organizer`.

## Troubleshooting

- **CI failed after the tag was pushed** — fix on `develop`, then either delete and
  re-push the tag (`git push --delete origin vX.Y.Z`; re-run) or ship the fix as the
  next patch. Once the Release exists, refresh only the tap with
  `yarn release X.Y.Z --homebrew-only`.
- **`NODE_MODULE_VERSION` mismatch in tests** — `npm rebuild better-sqlite3
  --build-from-source` (Node ABI) before `yarn test`; `yarn rebuild` restores the
  Electron ABI afterwards.
- **"tag already exists"** — the version was already released; pick the next one.
- **DMG download 401/403** — set `GITHUB_TOKEN`/`GH_TOKEN` in `.env`, or pass
  `--dmg <path>` / `--sha <hash>`.
- **Site shows the old version / falls back to the releases page** — confirm the app
  repo is still public and the new Release is published; the page reads
  `releases/latest` unauthenticated.
