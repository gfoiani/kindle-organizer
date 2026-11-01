# Real Kindle collections, synced automatically

**Date:** 2026-11-01
**Status:** approved (2026-11-01)

## Why

The header button "Scrivi su Kindle" writes the app's collections as `tags`
into the device's `metadata.calibre`. On the user's real Kindle (11th gen 2022,
KT5, firmware 5.18.3) that changes nothing: the collections on the device
("Prossime letture", "Letti", "Dan Brown"…) match none of those tags. Firmware
5.x builds its collections from `/var/local/cc.db`, a system database that
USB mass storage does not expose, and reads no file on the USB partition to
create them (calibre's FAQ says the same; Amazon removed the ability with the
Kindle Touch). So the button promises something it cannot do, and its label
("Scrivi su Kindle" / "Scrivi le collezioni su metadata.calibre nel Kindle")
reads as if it did.

The user wants the Kindle's collections to be the app's collections, with no
manual work. The only way to change `cc.db` is code running on the Kindle, so
the user jailbroke their Kindle (SpiderCat, jb.sh v2.5.0, 2026-11-01). This
design adds a small component that runs on a jailbroken Kindle and applies the
app's collections through the firmware's own catalog service, automatically,
every time the USB cable is unplugged.

## Decisions the user made

- **The app is the single source of truth.** After a sync the Kindle holds
  exactly the app's collections: missing ones are created, members are set to
  the app's books, and **collections that exist on the Kindle but not in the
  app are deleted** (books are never deleted, only the grouping).
- **…but only over the books the app can see.** Members of a Kindle collection
  that the app does not know — Amazon purchases, cloud-only or archived items,
  anything without a `documents/` file the app lists — **stay in their
  collection**. The component computes each collection's members as "the app's
  books for it" plus "the members it already had that are not books the app
  knows". A Kindle collection the app does not have is still deleted (see
  above). An app collection with no books on this device is not created there.
- **calibre tags are imported once, not on every connect.** Today every device
  load re-imports `metadata.calibre` tags as collections (`kindle:sync-calibre`
  → `importFromCalibre`), which would resurrect collections or memberships the
  user removed in the app. That automatic import stops. The calibre tags are
  offered once, in the first-sync question, next to the Kindle's own
  collections.
- **Public, marked experimental.** The feature ships in the public app,
  labelled "sperimentale", and is enabled only on a Kindle the app recognizes
  as jailbroken with jb.sh / KindleModding (the setup that provides the
  `emergency.sh` boot hook). Every other Kindle — not jailbroken, or jailbroken
  another way — gets a clear message ("jailbreak non supportato" / "serve un
  jailbreak") instead of the feature.
- **First sync asks.** The first time a Kindle is synced, the app shows the
  collections currently on the device and asks whether to import them into the
  app first ("initialize the app with the Kindle's collections") or to discard
  them. Only after that answer does the first mirror run.
- **Only top-level collections reach the Kindle.** Kindle collections are flat.
  An app collection "Giallo" becomes the Kindle collection "Giallo" containing
  the books of "Giallo" **and** of all its sub-collections ("Giallo / Cooper,
  Glenn", …). Sub-collections are not recreated on the device.
- **As automatic as possible.** The sync starts by itself when the user unplugs
  the Kindle; the app shows how it went the next time the Kindle is connected.
- **Install without typing commands.** The app copies the component and an
  installer; the user only restarts the Kindle once. Later versions of the
  component update themselves from files the app leaves on the device.
- **The button changes meaning and label.** No more "write" action. The header
  shows a status ("Collezioni Kindle: aggiornate" / "si aggiorneranno quando
  stacchi il Kindle" / last error), and, when the component is missing on a
  jailbroken Kindle, a button "Installa la sincronizzazione delle collezioni".
- **Remove what is no longer useful.** Writing collections into
  `metadata.calibre` (the `kindle:write-to-kindle` path, `writeCalibreMetadata`'s
  collection mirroring, its UI strings, the landing-page claim
  "Sincronizzazione Kindle — scrivi le tue collezioni direttamente sul
  dispositivo") goes away. Already done on the device: the SpiderCat book was
  deleted after the jailbreak.

## Goals

1. On a jailbroken Kindle reachable as USB mass storage, after connect → (app
   writes the desired state) → unplug, the device's collections equal the app's
   top-level collections restricted to books on that device, without any
   action on the Kindle.
2. First sync of a device: show its existing collections and let the user
   import them before they are deleted.
3. After each run the app can tell the user what happened: collections
   created/updated/deleted, books not yet indexed, errors.
4. One-time install: copy + one reboot. Self-update afterwards.
5. A Kindle that is not jailbroken gets an honest explanation in the UI instead
   of a button that does nothing.

## Non-goals

- Performing the jailbreak from the app, or shipping any exploit.
- Kindles that connect over MTP (2024+ models): the app does not support MTP at
  all today.
- A guided/manual checklist for non-jailbroken Kindles (the user rejected it).
- Two-way sync after the first import: changes made to collections on the
  Kindle are overwritten at the next sync (the app wins).
- Collections for books that are only in the app's library (not on the device).

## Anti-goals (would make this a failure even if it "works")

- Writing `cc.db` directly. Its `Entries` table uses ICU collation the stock
  `sqlite3` cannot honour, and the framework holds it open; a direct write can
  corrupt the user's library index. All changes go through the catalog
  service; `cc.db` is only ever **read** (from a snapshot).
- Deleting the user's existing Kindle collections before they had the chance
  to import them.
- Leaving `/mnt/us/emergency.sh` behind: it runs as root at **every** boot and
  makes jb.sh's own boot job skip its permission repairs. The installer must
  delete itself, also when it fails.
- Deleting or moving any book file.
- A component that keeps running work, polling hard, or draining the battery.

## Constraints and facts (verified 2026-11-01)

- **Device:** Kindle 11th gen 2022 (KT5), FW 5.18.3, mounts as FAT32 USB mass
  storage at `/Volumes/Kindle` on macOS. Jailbroken with SpiderCat; OTA updates
  blocked by jb.sh (renames `otaupd`/`otav3`).
- **Boot hook:** jb.sh installs `/etc/upstart/kmc.conf` (`start on
  framework_ready`), which runs `/bin/sh /mnt/us/emergency.sh` as root when that
  file exists, then returns. (Source: KindleModding/jb.sh
  `src/kmc/system_patches/kmc.conf`, `system_patch_jobs/08_install_kmc_upstart.sh`;
  kindlemodding.org "Hotfix" page.)
- **Persistence:** an upstart job copied into `/etc/upstart/` (after
  `mntroot rw`) survives reboots; jb.sh does the same for `kmc.conf`.
- **On-device tools already present:** BusyBox `sh`, `sqlite3`, `curl`,
  `lipc-get-prop` / `lipc-wait-event`. No Python. jb.sh also installs KPM
  (`/var/local/kmc/bin/kpm`) — not needed by this design.
- **Catalog service:** `POST http://127.0.0.1:9101/change`, JSON body
  `{"type":"ChangeRequest","id":…,"commands":[…]}`, header `AuthToken: <contents
  of /tmp/session_token>` (case-sensitive name; token changes every boot). Commands
  used by LibrarianSync (`cc_update.py`) and ccsync (`kindle/commander.go`):
  `insert` a `Collection` (uuid, `titles[0].display`, `isVisibleInHome`,
  `isArchived`, `mimeType: application/x-kindle-collection`,
  `collectionDataSetName`), `update` a Collection's `members` (exact list of
  book uuids — omitted members are dropped), `update` each `Entry:Item`'s
  `collectionCount`, `delete` by uuid. Reply `{"ok":true,…}`; slow — batch and
  retry on 503.
- **Reading collections:** `cc.db` `Entries` rows with `p_type='Collection'`
  (name `p_titles_0_nominal`) and `p_type='Entry:Item'` (`p_location` =
  `/mnt/us/documents/…`, `p_cdeKey`, `p_uuid`); membership in
  `Collections(i_collection_uuid, i_member_uuid, …)`. Read from a `.backup`
  snapshot, never the live file.
- **Indexing lag:** a book can join a collection only once the firmware has
  indexed it (a row in `Entries`), which happens after unplug.
- **Cloud:** on a registered, online Kindle, collections sync with the Amazon
  account. Deleting one on the device probably deletes it on the user's other
  Kindles/apps too, and other devices' collections can arrive through sync
  (they will be removed again at the next mirror). Accepted by the user as a
  consequence of "the app wins"; the first-sync import is the safety net.
- **Book identity in the app:** a device book's key is its POSIX/NFC path under
  `documents/` (`KindleBook.relpath`, see AGENTS.md "Book keys"). The component
  matches by `p_location` (`/mnt/us/documents/<relpath>`), case-insensitive
  (FAT), NFC-normalized. AZW3s the app sends also carry EXTH 113 = library id,
  which the firmware exposes as `p_cdeKey` — usable as a fallback key.
- **Untrusted input both ways:** files the device writes (`export.json`,
  `status.json`) are external input to the app — validate shape, sizes, paths.

## How it works

### Files on the USB partition (`/mnt/us/kindle-organizer/`)

| File | Written by | Purpose |
| --- | --- | --- |
| `desired.json` | app | top-level collection name → relpaths of member books on this device; a `mode` (`mirror` once the first-sync question is answered) |
| `desired.ready` | app, last | marks `desired.json` complete (e.g. its sha256), so a half-written file is never applied |
| `component/…` | app | the component and its version; the source for self-update |
| `export.json` | device | the device's collections after each run (names, member relpaths/cdeKeys) — feeds the first-sync import and the status |
| `status.json` | device | time, version, result, counts, books not yet indexed, errors |
| `log.txt` | device | bounded log for bug reports |

Writes from the app go through the existing atomic temp+rename helper.

### Install (once per device)

1. The app detects a jailbroken Kindle (e.g. `documents/JAILBROKEN.txt` or the
   jb.sh markers) with no component (`status.json` missing or older version)
   and offers "Installa la sincronizzazione delle collezioni".
2. It copies the component into `kindle-organizer/component/` and writes
   `/mnt/us/emergency.sh`: install the component under `/var/local/…`, install
   its upstart job (`start on started lab126_gui` or equivalent, `respawn`),
   start it, write a first `status.json`, and **delete itself in every case**.
3. The app tells the user to eject and restart the Kindle once.
4. On the next connection the app reads `status.json` / `export.json` and shows
   the first-sync question.

### Sync (every unplug)

1. While connected, whenever collections change (and on connect), the app
   writes `desired.json` + `desired.ready` for that device.
2. On the device the component waits for the USB session to end (lipc events
   from `com.lab126.hal` / `com.lab126.volumd`, plus a slow fallback check of
   `driveModeState`), then:
   - self-updates if `component/` holds a newer version;
   - snapshots `cc.db`, writes `export.json` (this is also the record of what
     existed before the run);
   - if `mode` allows it and `desired.json` changed (or books were still
     pending), waits a bounded time for the desired books to be indexed,
     computes the difference, and applies it through `/change` in batches;
   - writes `status.json` and `export.json` again.
3. On the next connection the app reads `status.json` and updates the header
   status; books still pending are retried at the next unplug.

### First sync

`desired.json` is written without `mode: mirror` until the user answers. The
app shows the collections from `export.json` with their book counts — and,
separately, the collections the `metadata.calibre` tags would give — and asks
whether to import them: "Importa queste collezioni nell'app" (they become app
collections, matched to the app's device books by relpath; members the app
cannot see stay on the Kindle anyway, per the rule above) or "Cancellale dal
Kindle". The answer is remembered per device. This replaces the import that
used to run on every connect.

### App side

- Planning (pure, unit-tested): app collections → top-level grouping (merging
  sub-collections) → restricted to the books on this device → `desired.json`.
- Status/import (pure, unit-tested): parse and validate `export.json` /
  `status.json`.
- IPC: replace `kindle:write-to-kindle` with channels for install, status, and
  the first-sync answer; follow the existing `requireKindleDrive` checks.
- UI: header status + install button + first-sync dialog, Italian and English
  strings, honest message for non-jailbroken Kindles.
- Removal: the `metadata.calibre` collections write and its strings, and the
  automatic `kindle:sync-calibre` import on every device load (now offered once
  in the first-sync question). Keep `metadata.calibre` registration after a
  send (calibre users still rely on it) and the backup/restore machinery
  (sends and deletes still write the file).
- Gating: detect "jailbroken with jb.sh / KindleModding" from what jb.sh leaves
  on the USB partition (`documents/JAILBROKEN.txt` with its `jb.sh vX` line);
  anything else gets the explanatory message. Mark the UI and the release notes
  "sperimentale"; replace the landing-page claim accordingly.

## Left to the builder

- Component runtime: POSIX shell on the device's `sqlite3` + `curl` (no new
  toolchain, harder to test) or a static Go binary (`GOARCH=arm GOARM=7
  CGO_ENABLED=0`, testable, adds a Go build step and a binary to ship).
  *Recommendation (my call):* whichever lets the diff logic be unit-tested off
  the device; e.g. keep the device side thin and push the planning into the
  app's TypeScript, with paths resolved to uuids on the device.
- Exact schemas of the files above, versioning, size caps.
- Event handling details and the indexing wait (bounded, reported).
- Batch size and retry policy for `/change`.
- How to test the device side without a Kindle (fake catalog service + fixture
  `cc.db`), plus the manual on-device test.

## Calls I made (not discussed with the user)

- Status pill + install button as the button's replacement; the exact Italian
  wording is a proposal.
- The component also exports the device's collections after every run, which
  doubles as the "before" record for each mirror.
- Detection of a supported jailbroken Kindle by the jb.sh files on the USB
  partition.
- Per-device identity (to remember the first-sync answer): an id the component
  writes into `status.json` on install.
- Imported Kindle collection names containing the app's ` / ` separator are
  kept as plain names (the separator is replaced, e.g. by " - "), so they do
  not turn into sub-collections.
- An imported collection whose name matches an existing app collection is
  merged into it.
- No signing of component updates: anyone who can write the USB partition can
  already run code as root through jb.sh's `emergency.sh` hook.
- An app collection that has no books on the device is skipped, not created
  empty.

## Verification

- Unit tests for planning, parsing, IPC; type-check; full suite green.
- On the real Kindle: install via one reboot; first-sync question with the
  user's current collections; import path; mirror path (create/update/delete);
  a freshly sent book joins its collection after unplug; status shown on the
  next connect; `emergency.sh` gone after install; reboot keeps the component.
- Before the first mirror on the real device, `export.json` must hold the
  existing collections (it is the only record of them besides the cloud).
