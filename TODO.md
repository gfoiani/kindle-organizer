# TODO

## Fase 6 — Convertitore incluso (fallback) + firma/notarizzazione — POSTICIPATA

**Stato:** posticipata di proposito (decisione utente, 2026-07-20). Non è una svista.

La feature "aggiungi/converti/carica EPUB" (branch `feat/library-staging-send-to-kindle`,
Fasi 1–5 + 7) funziona **oggi con Calibre installato**. Senza Calibre, "Invia al Kindle"
mostra il messaggio + link per installare Calibre. La Fase 6 aggiunge un binario di
conversione **incluso** nell'app come fallback quando Calibre non c'è.

### Perché è bloccata

- Serve una release di `seapy/kindle-cli` che spedisca binari macOS **dual-arch**
  (arm64 + x64) separati da fondere con `lipo` per la build universal.
- Serve una vera **notarizzazione** macOS: la firma in CI è ancora ad-hoc
  (`codesign --sign -`), quindi un binario esterno incluso non notarizzato può
  essere messo in quarantena da Gatekeeper. Da fare insieme al lavoro Developer ID.

### Da fare (quando si sblocca)

- [ ] Verificare/pinnare una release `kindle-cli` con binari macOS dual-arch (+ Windows/Linux).
- [ ] `scripts/download-converter.mjs` (modellato su `download-model.mjs`): tag pinnato,
      verifica size+sha256, estrazione archivio, `lipo -create` universale su macOS,
      scrittura temp-then-rename in `resources/converter/kindle-cli[.exe]`.
- [ ] `package.json` build: `extraResources: [{ from: 'resources/converter', to: 'converter' }]`
      + su macOS `mac.binaries: ['Contents/Resources/converter/kindle-cli']`
      (+ `hardenedRuntime`/`entitlements`/`notarize` quando si attiva la notarizzazione).
- [ ] `.github/workflows/build.yml`: step "Download converter" + cache
      (chiave su `hashFiles('scripts/download-converter.mjs')`) in tutti e 3 i job di build.
- [ ] Degradazione **solo-AZW3**: se motore = `bundled` e l'utente chiede MOBI →
      forzare AZW3 con avviso (o suggerire Calibre per MOBI).
      Nota: `src/main/convert.ts` ha già il ramo `'bundled'`, `bundledBinaryPath()` e
      `UnsupportedFormatError` — manca solo il binario e il packaging.

### Riferimenti

- Piano originale: `~/.claude/plans/controlla-esattamente-cosa-supporta-staged-papert.md` (sezione "Fasi", punto 6).
- Codice già predisposto: `src/main/convert.ts` (`detectEngine` → `'bundled'`, `bundledBinaryPath`).
