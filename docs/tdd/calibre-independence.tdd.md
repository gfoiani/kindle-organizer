# TDD evidence — calibre independence

Branch `feat/native-kf8-converter`. Source plan: the inline `/plan` of 2026-10-18
("make the app independent of whether calibre is installed"), with the
recommended decisions applied: D1 no calibre engine at all, D2 AZW3 only,
D3 create `metadata.calibre` when the Kindle has none.

## User journeys

- As a user without calibre, I send an EPUB to my Kindle and it arrives as an AZW3 with the app's title, author and cover, working links and a table of contents.
- As a user whose Kindle never saw calibre, I write my collections to the device and they are saved.
- As a user, when a book cannot be sent, I am told why (DRM-protected, damaged EPUB).

## RED → GREEN log

| Behaviour | RED commit (failure seen) | GREEN commit |
|---|---|---|
| Native KF8 writer | `dd1d28a` — `src/main/kf8` missing | `677d839` — 23 tests |
| EPUB → KF8 transform | `a039de7` — `src/main/epubConvert` missing | `88c786c` — 25 tests |
| `convert()` never spawns calibre, maps errors | `191739a` — `execFile` called, no codes | `7b53c71` — suite 364 |
| AZW3 is the only format | `31e9732` — `KINDLE_FORMAT` missing, `mobi` accepted | `a9cac7f` — suite 355 |
| Collections without `metadata.calibre` | `dd83fb6` — refused when file absent | `5a73050` — suite 357 |
| Hostile-input hardening | `865c4c4` — bomb accepted, `@font-face` scan 18.8 s, stack overflow… | `c6ba16c` — suite 367 |

Validation commands: `yarn type-check` (clean), `npx vitest run` (34 files,
367 tests passing), `yarn build` (succeeds).

## Guarantees

| # | What is guaranteed | Where | Type |
|---|---|---|---|
| 1 | The AZW3 parses as KF8 and reassembles into the original parts (independent reader) | `test/kf8Writer.test.ts` | unit |
| 2 | Index/CNCX records split past 64 KiB stay readable (5000 parts) | `test/kf8Writer.test.ts` | unit |
| 3 | A UTF-8 character cut by a record boundary survives | `test/kf8Writer.test.ts` | unit |
| 4 | Internal links land on their anchor; external kept; escapes dropped | `test/epubToKf8.test.ts` | unit |
| 5 | DRM refused, non-EPUB refused, abort honoured, progress ends at 100 | `test/epubToKf8.test.ts`, `test/convert.test.ts` | unit |
| 6 | `convert()` runs no external program | `test/convert.test.ts` | integration |
| 7 | Collections are written to a Kindle with no `metadata.calibre` | `test/calibre.test.ts` | unit |
| 8 | Zip bombs, ReDoS CSS, deep nesting, bad tag names are contained | `test/epubHardening.test.ts` | unit |

## Manual verification (not in CI)

- Calibre as an oracle on the dev machine: `calibre-debug --inspect-mobi` parses the output; `ebook-convert out.azw3 rt.epub` round-trips it.
- 12 real EPUBs (not committed): 60–450 ms each, all round-trip through calibre without warnings, text volume preserved 99.3–100 %, 1041 internal links with 0 broken.

## Coverage and gaps

`npx vitest run --coverage`: `kf8/` 98.8 % lines, `epubConvert/` 97 %,
`convert.ts` 85 %, `calibre.ts` 95 %. The project total (76 %) is held down by
files this work did not touch (`ipc.ts`, `index.ts`, `menu.ts`, `kindle.ts`).

Not yet verified: rendering on a physical Kindle. Renderer changes (failure
reasons in the detail sidebar and bulk send) have no automated test — the
renderer has no test harness yet.
