# Code Review: `feat/covers-redesign` → `develop`

**Reviewed:** 2026-07-19
**Branch:** `feat/covers-redesign` → `develop`
**Scope:** `develop...HEAD` — 1 commit (`a7a350e`), 20 files, +1805 / −469
**Decision:** 🟠 **REQUEST CHANGES** (2 HIGH, 3 MEDIUM, 2 LOW; nessun CRITICAL)

---

## Summary

Refactor solido e ben strutturato del sistema copertine: scheduler per-host
(`requestScheduler.ts`), protocollo `cover-cache://` con streaming da disco
(`coverProtocol.ts`), tassonomia errori tipizzata (`httpClient.ts`) e griglia
virtualizzata (`BooksGrid.tsx`), il tutto con una nuova suite di test.

La logica di concorrenza/abort e il ref-count `interest`/`controllers` in
`covers.ts`, lo scheduler per-host e le difese di sicurezza sono **corretti**.
I difetti reali sono nel **renderer** e nel **contratto di notifica
main→renderer**: due bug HIGH visibili all'utente a ogni avvio. La radice comune
di più finding è che una card in stato `pending` non ha modo di raggiungere uno
stato terminale se non tramite un push `found`.

---

## Findings

### CRITICAL

Nessuno. La superficie di sicurezza è solida:

- Guardia path-traversal `KEY_RE = /^[0-9a-f]{64}$/` — `src/main/coverProtocol.ts:99`
  (respinge `.`, `/`, `%2e`, lunghezza errata, non-hex prima di ogni accesso al FS;
  coperta da `test/coverProtocol.test.ts`).
- Allow-list SSRF sui redirect preservata — `src/main/httpClient.ts:1045`
  (`isAllowedHost`) + `resolveSafeRedirect` (solo https + host noti).
- Validazione input IPC mantenuta (`assertString`/`assertOptionalString`) e
  ri-validazione ISBN (`normalizeIsbn`) prima dell'interpolazione in URL.
- CSP estesa in modo mirato: `img-src ... cover-cache:` (nessun `bypassCSP`,
  scheme registrato come `{ standard: true, secure: true }`).
- Nessun segreto hardcoded; body cap `MAX_RESPONSE_BYTES` e timeout socket
  preservati.

### HIGH

**H1 — La griglia resta bloccata a 5 colonne e ignora il resize**
`src/renderer/src/components/BooksGrid.tsx:271`

L'effect del `ResizeObserver` fa early-return perché `scrollRef.current` è `null`
al mount: all'avvio si renderizza lo stato loading/empty (righe 317–327), non il
`<div ref={scrollRef}>` di riga 385. Le deps `[]` gli impediscono di
ri-eseguirsi quando la griglia compare davvero, quindi `containerWidth` resta
`0` per sempre → `columnsForWidth(0 || 1280) = 5` in modo permanente.

- **Scenario:** avvio normale (Kindle rilevato in async → `isLoadingBooks`/lista
  vuota al primo render). `BooksGrid` resta montato attraverso la transizione
  loading→loaded, ma l'effect di misura è già girato una volta con ref `null` e
  non riparte. Risultato: 5 colonne fisse su qualsiasi larghezza, cards
  schiacciate su finestre strette, nessun reflow al resize.
- **Fix:** attaccare il `ResizeObserver` tramite una callback-ref, oppure far
  dipendere l'effect dalla comparsa del contenitore (es. `filtered.length > 0` /
  `isLoading`).

**H2 — I libri senza copertina restano in "pulse" all'infinito al primo caricamento**
`src/main/covers.ts:471`

Il ramo `not-found` scrive il marker di negative-cache ma **non invia alcun
push** al renderer (`notifyCoverReady` è chiamato solo nel ramo `found`, righe
468 e 564).

- **Scenario:** primo caricamento di un libro senza copertina disponibile.
  `ensureCover` ritorna `{ status: 'pending' }` (download in background). Il
  download risolve `not-found` → scrive marker 0-byte, **nessun push**. La
  `BookCard` ha `status: 'pending'`, `version` resta `undefined`, quindi
  `showImage` è `false` e il render cade sullo skeleton `animate-pulse`
  (`BooksGrid.tsx:136`) a tempo indefinito. Passa a `missing` (placeholder
  estensione) solo a un successivo remount che rilegge il marker — quindi alla
  prima schermata ogni libro senza copertina mostra uno shimmer infinito.
- **Fix:** notificare il renderer anche su esiti terminali `not-found`/give-up
  (evento key-only che porti la card a `missing`).

### MEDIUM

**M3 — Retry esaurito: nessun negative-cache → ri-download completo a ogni rimontaggio**
`src/main/covers.ts:534` (`rescheduleOrGiveUp`, ramo else)

Il give-up fa solo `retryRegistry.delete(key)` senza scrivere `Buffer.alloc(0)`.

- **Scenario:** copertina il cui download fallisce ripetutamente con errori di
  rete esaurisce `RETRY_DELAYS_MS`. Alla successiva `ensureCover`: file assente +
  registry vuoto → riparte l'intera ricerca provider (iTunes → OpenLibrary →
  Google + fetch immagine) **a ogni scroll-in della card**, per sempre. La card
  resta inoltre in pulse permanente (stesso sintomo di H2).
- **Fix:** scrivere un negative-cache marker al give-up (e notificare, vedi H2).

**M4 — `?v=` che si azzera dopo un cache-clear collide con la cache `immutable` di Chromium**
`src/renderer/src/components/BooksGrid.tsx:253` + `src/main/coverProtocol.ts:154`

`onCoverCacheCleared` fa `setCoverVersions(new Map())`, quindi la versione
riparte da `undefined → 1`.

- **Scenario:** una copertina scaricata → push → `version 1` → `<img
  src=cover-cache://covers/<key>?v=1>`, servita con `Cache-Control:
  max-age=31536000, immutable` → Chromium la cache-a a vita. L'utente svuota la
  cache copertine per ottenerne una corretta: il re-download scrive byte
  **nuovi** su disco, ma l'URL torna `?v=1` (versione resettata) → identico a una
  entry immutable già in cache → Chromium serve l'immagine **vecchia**. Il
  "clear per aggiornare" non ha effetto per qualsiasi copertina il cui contenuto
  sia effettivamente cambiato.
- **Fix:** versione monotòna persistente, oppure includere `coverEpoch` nel
  query-string (`?v=<version>-<epoch>`).

**M5 — La sidebar di dettaglio mostra copertina vuota se aperta prima del download**
`src/renderer/src/components/BookDetailSidebar.tsx:153`

`onSelect` passa uno snapshot `coverSrc` che è `null` quando la card è ancora
`pending`; la sidebar non si iscrive a `onCoverUpdated`.

- **Scenario:** click su una card mentre la copertina è ancora in download →
  `coverSrc` è `null` → la sidebar renderizza il ramo "senza copertina" e resta
  vuota anche dopo che la copertina arriva (nessun re-fetch, prop `cover`
  catturata una volta).
- **Fix:** far reagire la sidebar a `onCoverUpdated` per la stessa cache key,
  oppure derivare la src dal libro selezionato in modo reattivo.

### LOW

**L6 — `columnsForWidth` usa breakpoint da viewport applicati alla larghezza del contenitore**
`src/renderer/src/components/BooksGrid.tsx:37`

Le soglie 640/1024/1280 erano media-query Tailwind sul **viewport**; ora sono
applicate al `clientWidth` del **contenitore** (più stretto per sidebar +
padding `p-6`), quindi il conteggio colonne non coincide con la vecchia griglia,
nonostante il commento affermi "mirrors the old sm/lg/xl grid". Si compone con
H1.

**L7 — `ensureCover` è ~75 righe**
`src/main/covers.ts:428`

Oltre la linea guida AGENTS.md di ~50 righe/funzione. Candidata a estrarre
l'helper del ciclo di vita download (setup controller/interest + closure `work`).

---

## Nota su immutabilità

Lo stato mutabile a livello di modulo in `requestScheduler.ts` / `covers.ts`
(`state.active++`, Map `.set/.delete`, contatori `let`) è bookkeeping interno e
contenuto, coerente col pattern preesistente (il vecchio `covers.ts` aveva già
`inFlight` / `lastRequestStart` / `requestChain`). Non è una violazione della
regola "no mutation" (che riguarda dati condivisi/passati). Gli update di stato
React usano correttamente `new Map(prev)`.

---

## Scansione convenzioni (AGENTS.md)

| Regola | Esito |
|---|---|
| No `console.log` in produzione (solo `debug()` gated + `console.error`) | ✅ Pulito |
| No `TODO`/`FIXME` introdotti | ✅ Nessuno |
| No `catch {}` vuoti / errori silenziati | ✅ Nessuno |
| Validazione ai boundary (IPC, risposte API, ISBN, chiave protocollo) | ✅ Presente |
| File < 800 righe | ✅ Max `covers.ts` ≈ 766 |
| Funzioni < ~50 righe | ⚠️ `ensureCover` ≈ 75 (L7) |
| Scritture atomiche | ✅ N/A — la cache copertine è in `userData`, non sul device Kindle |

---

## Validation Results

| Check | Result | Note |
|---|---|---|
| Type check | ⚠️ Skipped | Node 18 in env; `yarn` blocca su engine `>=22 <23`. Baseline già noto come rosso su file di config. |
| Lint | — | Nessuno script `lint` configurato. |
| Tests | ⚠️ Skipped | La suite non parte su Node 18: il Vite bundlato con Vitest richiede Node 22 (`ERR_REQUIRE_ESM` nel caricare `vitest.config.ts`). Da eseguire su Node 22 / CI. |
| Build | ⚠️ Skipped | `electron-vite build` richiede Node 22. |

I test **aggiunti** (`covers`, `httpClient`, `requestScheduler`, `coverProtocol`,
`coverSrc`) sono ben scritti e coprono cache-hit/miss, chiave ISBN, guardia
traversal, concorrenza per-host e abort. **Nessuno copre però i due bug HIGH**
(griglia non responsive; pulse infinito su `not-found`) — coerente col fatto che
sono sfuggiti.

---

## Files Reviewed

**Added:** `src/main/coverPaths.ts`, `src/main/coverProtocol.ts`,
`src/main/httpClient.ts`, `src/main/requestScheduler.ts`,
`src/renderer/src/utils/coverSrc.ts`, `test/coverProtocol.test.ts`,
`test/coverSrc.test.ts`, `test/httpClient.test.ts`,
`test/requestScheduler.test.ts`, `test/setup/httpMock.ts`

**Modified:** `src/main/covers.ts`, `src/main/index.ts`, `src/main/ipc.ts`,
`src/preload/api.ts`, `src/renderer/index.html`,
`src/renderer/src/components/BooksGrid.tsx`, `test/covers.test.ts`,
`test/setup/electron-mock.ts`, `package.json`, `yarn.lock`

**Deleted:** `src/renderer/src/utils/coverCacheKey.ts`

---

## Prossimi passi consigliati

1. **Fix di fondo (altitude):** notificare il renderer per **ogni** esito
   terminale del download (found / not-found / give-up), non solo il successo —
   risolve H2, M3 e la componente renderer di M5 alla radice.
2. **H1:** attaccare il `ResizeObserver` con una callback-ref (o dep sul
   contenitore) così `containerWidth` viene misurato quando la griglia compare.
3. **M4:** rendere il cache-buster monotòno o includere `coverEpoch`.
4. Eseguire `yarn test` / `yarn type-check` / `yarn build` su **Node 22** e
   aggiungere copertura di test per H1 e H2.
