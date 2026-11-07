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

## Coverage and known gaps

Command: `yarn -s vitest run --coverage --coverage.include='src/main/kindleSync/**' --coverage.include='src/main/atomicWrite.ts'`.

Result: all files at 97.05% statements, 93.52% branches, 94.91% functions, 97.64% lines.

Uncovered:
- `closeKindleSyncDb`, which only runs on `will-quit`;
- the log line in `atomicWrite` for a failed cleanup;
- one branch in `jailbreak.ts`: the log for an unexpected error, other than missing.

Not done yet:
- **UI:** status pill, first-sync dialog, install button, "sperimentale" label. The header currently has no sync action.
- **Install channel and on-device component:** Phase 3. The runtime choice (shell or Go) is still open.
- **Dead code:** `writeCalibreMetadata` has no callers in the app any more.
  - Removing it means reworking the backup tests in `calibreBackup.test.ts`. They use it as a non-routine writer: the 10-copy limit and restore order.
  - That is a separate refactor.
- **Not tested:** nothing in the renderer. The removal of the "Scrivi su Kindle" button is covered by type-check only.
- **On the real Kindle:** only jailbreak detection, read-only. Nothing has been written to the device yet.
