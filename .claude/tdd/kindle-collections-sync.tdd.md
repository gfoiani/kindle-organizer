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
- **Landing page (`../site`):** the old claim "Sincronizzazione Kindle — scrivi le tue collezioni direttamente sul dispositivo" has not been replaced yet.
- **Install channel and on-device component:** Phase 3. The runtime choice (shell or Go) is still open.
- **Dead code:** `writeCalibreMetadata` has no callers in the app any more.
  - Removing it means reworking the backup tests in `calibreBackup.test.ts`. They use it as a non-routine writer: the 10-copy limit and restore order.
  - That is a separate refactor.
- **Not tested:** the React components and `useKindleSync`. Vitest runs in node here, with no jsdom or Testing Library. Their rules live in `kindleSyncView.ts`, which is tested; the wiring is covered by type-check and one `yarn dev` run.
- **On the real Kindle:** only jailbreak detection, read-only. Nothing has been written to the device yet.
