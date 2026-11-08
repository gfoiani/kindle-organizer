# TDD evidence: Kindle collections sync, app side

**Branch:** `feat/kindle-collections-sync`, cut from `fix/review-findings` at `00c3114`.
**Source plan:** `docs/superpowers/specs/2026-11-01-kindle-collections-sync-design.md`, approved 2026-11-01. No `*.plan.md` file exists. The journeys below come from that design and from the user's decision on 2026-11-07.
**Validation commands:** `nvm use` first, then:
- `yarn -s vitest run <files>` for each target;
- `yarn test` and `yarn type-check` for the whole repository.

## User journeys

1. As a user with a jailbroken Kindle, I want the Kindle's collections to equal the app's top-level collections after I unplug, so that I never organize books twice.
2. As a user syncing a Kindle for the first time, I want to see its existing collections and import them before anything is deleted.
3. As a user whose Kindle is not jailbroken, I want an honest state instead of a button that does nothing. My calibre tags must keep becoming collections, as before (option A).
4. As a user, I want files written by the device to never corrupt the app, and the app's writes to never leave a half-written file on the device.

## Decisions taken during this run

- **Option A**, chosen by the user on 2026-11-07:
  - Calibre tags are imported on connect until that Kindle's first-sync question is answered.
  - A Kindle without the sync never answers it, so it keeps importing them.
  - The user chose it as "keep the import on Kindles without a jailbreak". The rule above is how it is implemented: only Kindles with the component can answer.
- **Empty planned collections**, my call: an app collection with no books on the device is still listed in `desired.json`, empty.
  - Without it, a Kindle collection imported with only Amazon items would be deleted by the very next mirror.
  - Consequence for the component: it must **not create** an empty collection, but must **keep** an existing one.
- **`appliedDesired` in `status.json`**, my call (third session):
  - The design wants the header to tell "up to date" from "will update when you unplug it", which needs to know what the device last applied.
  - The component reports the sha256 of the `desired.json` it applied, or `null`. The app compares it with the file it just wrote.
  - Nothing is on the device yet, so the contract could still change.
- **First-sync dialog**, my calls:
  - It does not list the calibre tags separately, as the design proposed. With option A they are already imported on every connect until the answer.
  - It opens by itself once per Kindle per session. "Later" closes it, and the header status reopens it.
  - Deleting the Kindle's collections takes two clicks. A Kindle with no collections gets a single "Start syncing" button.
- **No install button yet:** the install channel and the component are Phase 3. The status says "not installed" and does not offer an action that cannot work.
- **Component runtime: Go**, chosen by the user on 2026-11-08: a static `GOARCH=arm GOARM=7 CGO_ENABLED=0` binary, standard library only, reading `cc.db` through the device's own `sqlite3`. Shell only for `emergency.sh` and the upstart job.
- **Jailbreak guide, not jailbreak**, agreed with the user on 2026-11-08: the app never jailbreaks a device. A Kindle without jb.sh, or with another jailbreak, gets a link to kindlemodding.org next to the status, described as optional and at the user's own risk.
- **Landing page on a branch**: `../site` deploys from `main` and describes the latest release, which still has *Write to Kindle*. The new wording sits on the site's `feat/kindle-collections-sync` branch, to merge when the release ships.
- **Import names**, as stated in the design's "Calls I made":
  - " / " becomes " - " in imported names.
  - A name that matches an existing app collection, ignoring case, joins that collection.

## Task report

| # | Behavior | RED commit, evidence | GREEN commit, evidence |
|---|----------|----------------------|------------------------|
| 1 | Planner: app collections become flat Kindle collections | `570ba46`: `kindleSyncPlan.test.ts` fails, module missing | `eaf7a55`: plan + calibre tests, 41 passed |
| 2 | File contract: `desired.json` + ready marker; `export.json` / `status.json` validated whole | `ae0269c`: `kindleSyncFiles.test.ts` fails, module missing | `ad80c80`: 27 passed |
| 3 | jb.sh jailbreak detection | `4603361`: `kindleSyncJailbreak.test.ts` fails, module missing | `a9da70f`: 6 passed; read-only on the real Kindle → `{kind: jbsh, version: 2.5.0}` |
| 4 | Device I/O: atomic writes, unchanged state not rewritten, links and oversized files refused | `9ae7eeb`: `kindleSyncDeviceFiles.test.ts` fails, module missing | `812ece1`: 12 passed; suite 642 passed |
| 5 | `writeFileAtomically`, moved out of `convert.ts` | — (characterization of moved code) | `0e9b717`: 2 passed on first run |
| 6 | Planner keeps empty collections | `25dd04a`: 1 failed, received `[]` | `6565510`: 50 passed |
| 7 | First-sync import plan + answer store per Kindle | `0b9b880`: compile-time, `Cannot find module importPlan / firstSyncAnswers` | `b1fe192`: 10 passed; type-check clean |
| 8 | IPC: `kindle-sync:refresh`, `kindle-sync:answer-first-sync`, calibre import retired after the answer, `kindle:write-to-kindle` removed | `62698fa`: 14 failed, 1 passed; handlers missing, old channel still registered | `211eee9`: 15 passed; suite 669 passed (58 files); type-check clean |
| 9 | `status.json` gains `appliedDesired`; the `active` state reports `upToDate` | `52ba7b3`: 9 failed; field dropped / not required, no `upToDate` | `2250d82`: 59 passed; type-check clean |
| 10 | Header status rules (`describeKindleSync`), auto-open of the first-sync question, Kindle collections sorted | `4ebfc58`: compile-time, `Cannot find module …/utils/kindleSyncView` | `a54901a`: 17 passed; type-check clean |
| 11 | UI wiring: `useKindleSync`, `KindleSyncStatus`, `FirstSyncDialog`, IT/EN strings | — (no renderer component tests in this repo) | `d5c99d1`: type-check clean; suite 691 passed; `yarn dev` with the real Kindle shows "Collezioni Kindle: sincronizzazione non installata · SPERIMENTALE", and `/Volumes/Kindle/kindle-organizer` was not created |
| 12 | The status links the jailbreak guide only for a Kindle without jb.sh or with another jailbreak (`guideUrl`) | `3aca4ce`: 4 failed, 14 passed; `guideUrl` undefined | `e160f54`: 18 passed; type-check clean |
| 13 | `writeCalibreMetadata` removed; backup rules exercised through the writers that remain, with a fake clock | — (refactor). `367cb7a`: reworked tests 31 passed with the function still present | `146c535`: type-check clean; suite 681 passed (59 files) |

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|--------------------|------|------|--------|
| 1 | Sub-collections merge into their top-level collection; only books on the device are kept, matched by case and Unicode form | `test/kindleSyncPlan.test.ts` | unit | PASS (11) |
| 2 | An app collection with no books on the device is planned empty, so the mirror keeps it | `kindleSyncPlan.test.ts`: "still planned, empty" | unit | PASS |
| 3 | A device file that breaks the schema is rejected whole; paths outside `documents/` or containing `..` are refused; text is capped | `test/kindleSyncFiles.test.ts` | unit | PASS (27) |
| 4 | Only a jb.sh marker enables the sync; links are not followed | `test/kindleSyncJailbreak.test.ts` | unit | PASS (6) |
| 5 | `desired.ready` is written after `desired.json`; identical state is not rewritten; a linked sync folder is refused | `test/kindleSyncDeviceFiles.test.ts` | integration (fs) | PASS (12) |
| 6 | Imported Kindle collections map to the app's keys; " / " becomes " - "; existing names are reused, ignoring case; Amazon-only collections are kept | `test/kindleSyncImport.test.ts` | unit | PASS (7) |
| 7 | The first-sync answer is stored per `deviceId` and can be replaced | `test/kindleSyncAnswers.test.ts` | integration (SQLite) | PASS (3) |
| 8 | Nothing is written to a Kindle without a jailbreak, or with jb.sh but no component | `test/ipcKindleSync.test.ts` | integration (IPC) | PASS |
| 9 | Before the answer: Kindle collections are shown with their counts; `desired.json` is in `hold` mode; an unreadable export shows as `null`, not "no collections" | `ipcKindleSync.test.ts` | integration (IPC) | PASS |
| 10 | Import or discard, then `mirror` mode; import is refused while the export is unreadable, and nothing is remembered; invalid answers raise `TypeError` | `ipcKindleSync.test.ts` | integration (IPC) | PASS |
| 11 | Calibre tags are imported on connect until the answer, then no longer | `ipcKindleSync.test.ts` | integration (IPC) | PASS |
| 12 | The new channels refuse a path that is not a connected Kindle | `test/ipc.test.ts`: "refuses a path that is not a Kindle" | integration (IPC) | PASS |
| 13 | The Kindle is "up to date" only when its last run applied the `desired.json` the app wants now; any collection change makes it pending again | `ipcKindleSync.test.ts`: "whether the Kindle holds the current collections" | integration (IPC) | PASS |
| 14 | `appliedDesired` must be `null` or sha256 hex | `kindleSyncFiles.test.ts` | unit | PASS |
| 15 | Header status: muted explanation without the sync; action while the first sync is due; a failed run wins, with or without the device message; books not yet indexed are counted; otherwise pending or up to date | `test/kindleSyncView.test.ts` | unit | PASS (17) |
| 16 | The first-sync question opens by itself once per Kindle, not after "Later", and never when it is not due | `kindleSyncView.test.ts`: `shouldOfferFirstSync` | unit | PASS |
| 17 | The jailbreak guide (kindlemodding.org) is linked only while the jailbreak is what is missing: never once installed, in the first-sync state or after a run | `kindleSyncView.test.ts` | unit | PASS |
| 18 | `metadata.calibre` backups: a copy before every overwrite, none without a file, at most 10, a routine burst keeps the pre-burst file, no write when the copy fails, restore of an older copy is undoable — via `upsertCalibreEntry` / `removeCalibreEntries` / `restoreCalibreBackup` | `calibreBackup.test.ts` | unit (fs) | PASS |

## Coverage and known gaps

Command: `yarn -s vitest run --coverage --coverage.include='src/main/kindleSync/**' --coverage.include='src/main/atomicWrite.ts'`.

Result after the second session: all files at 97.05% statements, 93.52% branches, 94.91% functions, 97.64% lines.

Third session:
- `--coverage.include='src/main/kindleSync/**'` → 97.5% statements, 95% branches, 96.55% functions, 98.19% lines.
- `src/renderer/src/utils/kindleSyncView.ts` → 100% on all four measures (`--coverage.include='**/kindleSyncView.ts'`).
- Suite: 691 passed, 59 files.

Uncovered:
- `closeKindleSyncDb`, which only runs on `will-quit`;
- the log line in `atomicWrite` for a failed cleanup;
- one branch in `jailbreak.ts`: the log for an unexpected error, other than missing.

Not done yet:
- **UI:** done except the install button, which waits for the install channel.
  - The first-sync dialog was not seen running: it needs a `status.json` on the device, and nothing was written to the real Kindle.
  - Likewise for the "up to date", "pending" and "failed" states.
- **Claims (fourth session):** fixed in About (`about.feature3`), README and CHANGELOG. The landing page change waits on the site's `feat/kindle-collections-sync` branch for the release.
- **Install channel and on-device component:** Phase 3, in Go (decided 2026-11-08). Not started.
- **Jailbreak guide link:** not seen running. The test Kindle has jb.sh, so it shows "not installed", where the link does not appear.
- **Not tested:** the React components and `useKindleSync`. Vitest runs in node here, with no jsdom or Testing Library. Their rules live in `kindleSyncView.ts`, which is tested; the wiring is covered by type-check and one `yarn dev` run.
- **On the real Kindle:** only jailbreak detection, read-only. Nothing has been written to the device yet.

Fourth session (2026-11-08) coverage, `npx vitest run … --coverage`:
- `kindleSyncView.ts`: 100% statements, branches and lines.
- `calibre.ts`: 84.6% statements, 79.8% branches. `calibreBackup.ts`: 91.9% / 87.5%. The uncovered lines are log-only error paths.
- Full suite: 681 passed, 59 files. 691 − 13 `writeCalibreMetadata` tests + 2 moved to `upsertCalibreEntry` + 1 for the guide link.

## On-device component (Go), fifth session (2026-11-08)

Source: the design spec plus the user's choice of Go. Verified command shapes for `/change` come from ccsync (sandman7920/ccsync, MIT, `kindle/commander.go`). LibrarianSync could not be fetched. A forum report that the service replaces the whole member list on every update, and chokes on large requests, led to full member lists and batches of 100.

| # | Behavior | RED commit, evidence | GREEN commit, evidence |
|---|----------|----------------------|------------------------|
| C1 | File contract, cc.db reader, change plan | `ea7b5f4`: compile-time, undefined `ParseDesired`, `parseHexRows`, `Compute`… | `1be0014`: contract 96.0%, library 85.7% (the sqlite3 fixture test ran), plan 100% |
| C2 | `/change` client, device files, one sync run | `fd9fc91`: compile-time, undefined `Batches`, `Dir`, `Run`… | `5a46d15`: catalog 91.1%, devicefs 80.7%, syncrun 93.7%. The first AuthToken assertion could not pass (Go's test server canonicalizes header names) and was moved to the client side; a mutation to `Header.Set` is caught |
| C3 | When to sync; log tail on the USB partition | `1e0722a`, then `8c2e157`: two expectations changed before implementation (no start-up sync while USB drive mode is on; one back-off per failed wait) | `5555274`: watch 96.0%, devicefs 80.6%; `yarn build:component` gives ELF 32-bit ARM EABI5, static, 6.3 MB |
| C4 | One set of contract files checked by both languages | — (contract tests over existing code) | `cc98eba`: Go ok, vitest 3 passed. Renaming `pendingBooks` in the status file fails both sides |
| C5 | Read-only diagnostic `emergency.sh` | — | `c28f3f9`: `sh -n` ok. **Not run, not copied to the Kindle** |
| C6 | Fixes from the independent Go review (ecc:go-reviewer): (1) never touch /mnt/us unless it is mounted and out of USB drive mode, and stop without applying if the cable goes back in; (2) a pause after every event wait; (3) merged duplicates deleted after the member updates | `fcdb0f1`: compile-time, undefined `Plan.Merged`, `Watcher.MinInterval`, `Deps.DeviceReady`… | this commit: all packages ok (catalog 91.4%, syncrun 92.3%, watch 96.2%, plan 100%); `go vet` for darwin and linux/arm. Also: timeouts on sqlite3/lipc, lipc-wait-event killed with kosync (Pdeathsig, WaitDelay), shutdown no longer costs a minute, desired.json cap 32 → 8 MiB, `-init /dev/null` on the snapshot call |

| # | What is guaranteed | Where | Result |
|---|--------------------|-------|--------|
| G1 | desired.json is applied only when desired.ready holds its sha256; anything off-schema is refused whole (paths leaving documents/, blank names, over 5000 collections) | `contract_test.go` | PASS |
| G2 | status.json always carries `pendingBooks` (list) and `appliedDesired` (null when nothing applied); errors are capped at 1000 characters | `contract_test.go` | PASS |
| G3 | cc.db is read from a `.backup` snapshot, every value as hex, so names with `\|`, newlines or emoji survive; the snapshot is removed; a missing database is an error, not an empty library | `library_test.go` (real sqlite3) | PASS |
| G4 | Plan: missing collections are created but never empty; existing ones are kept with the members the app cannot see; collections the app lacks are deleted; matching ignores case and Unicode form; same-named Kindle collections merge; unindexed books are pending; collectionCount changes only where it moves | `plan_test.go` | PASS (100%) |
| G5 | `/change`: deletes first, each insert with its members in the same request, at most BatchSize per request, AuthToken spelled exactly, 503 retried with growing waits, any other failure or `{"ok":false}` stops, nothing is sent without a token or for an empty plan | `catalog_test.go` | PASS |
| G6 | Writes are temp + fsync + rename; a failed write leaves the previous file; desired.json is capped at 32 MiB; the device id is created once and kept | `devicefs_test.go` | PASS |
| G7 | A run exports first (even when desired.json is bad); `hold` or no desired.json changes nothing; waits a bounded time for indexing; partial with pendingBooks; `appliedDesired` only when the plan went through | `syncrun_test.go` | PASS |
| G8 | Sync at start only outside USB drive mode, then whenever drive mode ends; a failed event wait backs off; a failed sync never stops the loop | `watch_test.go` | PASS |
| G9 | The app's desired.* and the component's status/export agree byte for byte | `fixtures_test.go` + `test/kindleSyncContract.test.ts` | PASS |

Commands: `yarn test:component` (go vet + go test -cover), `yarn build:component`. App suite after this session: 684 passed, type-check clean.

Not verified, needs the Kindle:
- the `com.lab126.hal` event names (`usbPlugIn` / `usbPlugOut`). With a wrong name each wait ends at its 15-minute timeout, so the sync still runs, late;
- the output of `lipc-get-prop … driveModeState`;
- whether the catalog service accepts the insert shape on FW 5.18.3 and what its reply looks like;
- whether the device's sqlite3 accepts `-init`, `-noheader` and `-list`;
- which columns cc.db really has.

The diagnostic script records each of these.

Review findings left open, by choice:
- **A 200 reply without `"ok"`** counts as success, as in ccsync, which never reads the body. Requiring `ok:true` before the reply is seen on the device could fail every sync.
- **collectionCount after a partial failure.** If member updates land but the counts batch fails, the next run sees no membership change and never fixes the counts. The fix needs the stored count column, which the diagnostic will show.
- **"App-owned" is any listed format under documents/.** A book the app does not list (hidden folder, too deep) would be dropped from a collection. The fix would be to add the app's book list to desired.json, a contract change for later.
- **Plugging in and out within one sync** is noticed only at the next unplug.
- **The index wait** (up to 2 minutes) repeats on every unplug while a desired book never appears.
- **Low items:** no directory fsync after rename; `ToLower` instead of full case folding; the log is rotated non-atomically; a failed device-id write leaves no status.

Not done:
- the install channel, meaning the installer `emergency.sh` and the upstart job, and the app's install button;
- self-update;
- bundling the binary into the app;
- Go in CI;
- export.json is not capped at the app's limits (5000 collections / 100,000 members). Beyond them the app refuses the whole file.

