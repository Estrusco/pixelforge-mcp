# Piano post-sync upstream — bonifica, upstreaming, decisione superficie

> **Redatto:** 2026-09-10 · **Branch:** `claude/overlap-original-features-a8uh4v` · **Baseline:** `4b6bdd1` (v0.52.202)
>
> Piano destinato a essere **eseguito su un'altra macchina**. È autoportante: ogni step ha i comandi,
> i path esatti e i criteri di verifica. Prima di iniziare, allineare il checkout alla baseline sopra
> (`git log --oneline -1` deve mostrare `4b6bdd1`, o un discendente) e rileggere lo "Stato di partenza"
> per confermare che i gate siano ancora nella condizione descritta — upstream rilascia ~8 volte al
> giorno, quindi un sync intercorso può aver spostato i numeri.

## Stato di avanzamento

| step | stato |
|---|---|
| 1 — `ci.yml` / `.gitattributes` | ✅ **fatto** in sessione, commit `aadf5e4` |
| 0, 1b, 1c, 2, 3, 4, 5, 6, 7 | ⬜ da fare sulla macchina di esecuzione |

**I bead NON sono stati creati.** `bd` non è disponibile in questo ambiente (stessa limitazione
annotata in `PixelForgeDocumentations/backlog-proposals.md`: l'installer è bloccato dalla policy
dell'ambiente nelle sessioni Claude Code on the web). Lo Step 0 va eseguito per intero sulla
macchina di destinazione, dove `bd` è configurato.

## Context

Il 2026-09-09 il fork ha assorbito ~5 settimane di upstream (`artokun/comfyui-mcp`) nel merge
`02bc1ef`, arrivando a 0.52.202. Quel sync ha portato dentro la **consolidation 0.49.0/0.50.0**:
121 nomi di tool ritirati, tool action-parameterized, e un *ledger* (`src/tools/vocabulary.ts`) con
gate CI che verifica che nessun testo del repo dica a un modello di chiamare un nome morto.

Conseguenza misurata: **`npm run check:vocabulary` è ROSSO — 438 riferimenti a nomi ritirati**,
quasi tutti fork-side. Tra questi ~44 stanno nelle *descrizioni dei nostri tool*, cioè in stringhe
che il modello legge e su cui agisce: `generate_sprite` gli dice di cercare i modelli con un tool
CivitAI che non esiste più, `get_sprite_result` di guardare l'immagine con un viewer ritirato,
`remove_background` di fare lo staging con un tool ritirato. Tutti e tre oggi rispondono con un
redirect "removed in 0.50.0" che il modello non sa diagnosticare. È un bug di comportamento, non un
neo cosmetico.

In parallelo l'analisi di sovrapposizione ha prodotto due esiti da chiudere:
1. alcune modifiche che il fork ha fatto ai **servizi upstream** sono generiche e senza accoppiamento
   pixel-art — candidate a PR upstream (upstream accetta contributi esterni: 3 PR mergiate su 254,
   tutte piccole e platform-shaped);
2. upstream ha un ratchet dichiarato `MAX_TOOLS = 52` / `TOOL_BUDGET_TARGET = 30` mentre il fork
   contribuisce **14 nomi**: prima o poi i nostri nomi saranno l'unica ragione per cui il ratchet non
   chiude. Va deciso a freddo, non sotto un merge.

**Esito atteso del piano:** CI verde, descrizioni dei tool che nominano tool esistenti, un conflitto
di merge ricorrente eliminato, una PR upstream aperta come sonda, e una decisione scritta sulla
superficie sprite.

---

## Stato di partenza (verificato su CI run 34451044623 + riproduzione locale, 2026-09-10)

**`npm test` non è vitest.** È `node scripts/run-checks.mjs`: un runner ombrello che esegue la
suite vitest **più** una dozzina di gate, e stampa un SUMMARY finale. Quindi "npm test rosso" non
significa "test rotti", e i gate che compaiono come step separati in `ci.yml` sono in gran parte
già girati dentro `npm test`.

| gate | stato |
|---|---|
| `vitest` (dentro `npm test`) | ✅ verde |
| `npm run lint` (tsc --noEmit + anti-slop) | ✅ verde |
| `check:unknown-collapse` | ✅ verde (0 siti) |
| `check:anti-slop` | ✅ verde (796 finding a baseline, nessuno nuovo) |
| `vocab:export --check` | ✅ verde (52 core, 96 panel, 159 dead) |
| `i18n:check`, `check:docs-links`, `check:docs-mdx`, `check:blog*`, `check:changelog` | ✅ verdi |
| **`check:vocabulary`** | ❌ **ROSSO — 438 riferimenti** |
| **`asset-counts`** | ❌ **ROSSO — 13 claim** |
| **`check:docs-locale`** | ❌ **ROSSO — 22 problemi strutturali** |
| **`Pack & install smoke`** | ❌ **ROSSO — vedi Step 1b** |

Tutti e quattro i rossi sono **debito del fork, pre-esistente su `main`**: nessuno è causato da
codice upstream e nessuno è un flake.

Branch di lavoro: `claude/overlap-original-features-a8uh4v` (già esistente su origin).

### Distribuzione dei 438 riferimenti

| file | occorrenze | trattamento |
|---|---|---|
| `PixelForgeDocumentations/agents/pixelforge-expert-{opus,sonnet}.md` | 183 + 183 | **riscrittura** (Step 5) |
| `PixelForge_Gap_Report{,_Plan}_2026-08-02.md` | 6 + 10 | **esenzione HISTORICAL** (Step 4) |
| `.beads/interactions.jsonl` | 7 | **esenzione HISTORICAL** (Step 4) |
| `src/**` (codice runtime + 1 test) | ~30 | **riscrittura** (Step 2) |
| `.claude/agents/*` + `.clinerules/workflows/*` | 14 | **riscrittura** (Step 3) |
| `fork-customization/tool-surface.md`, `repo-layout.md` | 5 | **riscrittura** (Step 2) |

---

## Regole d'ingaggio (valgono per tutti gli step)

- **Un branch per step**, un commit coerente per step. Non impastare Step 2 e Step 5.
- Prima di ogni commit: `npm run lint && npm test && npm run check:vocabulary`.
- **Mai allargare la lista `HISTORICAL` per far passare il gate** se il file è guida viva. Il gate lo
  dice esplicitamente in `scripts/check-tool-vocabulary.mts:63-78`. Le due esenzioni dello Step 4 sono
  legittime perché sono *dati*, non istruzioni — stesso argomento del già-esente
  `packs/*/workflow.json`.
- **Non toccare** `src/tools/vocabulary.ts` `TOOL_NAMES`, `MAX_TOOLS`, `BASELINE_SHA256`. Nessuno step
  qui aggiunge o rimuove tool. Se un gate lamenta il baseline, hai sbagliato qualcosa.
- Il task tracking è **beads (`bd`)**, non TodoWrite né liste markdown (CLAUDE.md).
- Profilo git: **conservativo**. Commit sì (il branch è designato), push sul branch designato sì.
  Nessuna PR su `Estrusco/pixelforge-mcp` senza richiesta esplicita.

### La lista di lavoro è l'output del gate, non questo file

`npm run check:vocabulary` stampa, per **ogni** riferimento: il file, la riga, il testo che lo
contiene e il sostituto esatto letto dal ledger (`DEAD_NAMES` in `src/tools/vocabulary.ts`).

```bash
npm run check:vocabulary 2>&1 | tee /tmp/vocab-worklist.txt
```

Quello è l'elenco autoritativo. **Questo piano non ricopia la tabella dei nomi ritirati, e non
deve farlo**: il gate scandisce ogni file tracciato del repo, quindi un documento che elenca nomi
morti diventa *esso stesso* un riferimento da bonificare — questo file è stato riscritto una volta
proprio per quel motivo. Vale per qualunque nota tu prenda dentro il repo mentre lavori: tienila
fuori (`/tmp`) o scrivi solo i nomi vivi.

**Forma accettata.** Il gate distingue *rot* (prosa che dice a un modello di chiamare un nome che
oggi risponde 404) da *migrazione* (`rotMentions`, `src/tools/vocabulary.ts:624`). Nominare il
tool vivo con la sua azione è sempre accettato:

- ❌ il nome ritirato da solo, anche dentro backtick o in una cella di tabella
- ✅ `get_image (action:"view")`, `queue (action:"status")`, `download_model (action:"search_civitai")` …

Quindi la riscrittura non è "cancella la menzione": è "di' al modello cosa chiamare **oggi**".

---

## Step 0 — Setup (5 min)

```bash
git checkout claude/overlap-original-features-a8uh4v
git pull origin claude/overlap-original-features-a8uh4v
git config merge.ours.driver true      # richiesto da .gitattributes, per-clone
npm ci
npm run check:vocabulary 2>&1 | tee /tmp/vocab-before.txt
```

Aprire i bead (prefisso di progetto: vedi `.beads/config.yaml`):

```bash
bd create "Bonifica nomi tool ritirati nel codice sprite"      # Step 2
bd create "Bonifica nomi tool ritirati nei prompt subagent"    # Step 3
bd create "Esenzioni HISTORICAL per Gap Report e beads log"    # Step 4
bd create "Riscrittura pixelforge-expert-{opus,sonnet}"        # Step 5
bd create "PR upstream: luma_key su remove_background"         # Step 6
bd create "Design doc: consolidamento sprite tool surface"     # Step 7
bd create "ci.yml: eliminare il conflitto CRLF ricorrente"     # Step 1
```

---

## Step 1 — `ci.yml`: eliminare un conflitto di merge gratuito ✅ FATTO (`aadf5e4`)

> Eseguito il 2026-09-10 in sessione. `.github/workflows/ci.yml` è ora byte-identico a upstream
> (`git diff d996e12 -- .github/workflows/ci.yml` vuoto, CRLF preservati) e `.gitattributes` porta
> la regola `-text` che impedisce la ri-normalizzazione. Il resto della sezione è conservato come
> referto di cosa è stato fatto e perché.

**Problema.** `.github/workflows/ci.yml` differisce da upstream **solo per i line-ending** (228 righe,
upstream CRLF / fork LF, verificato con `git diff --ignore-cr-at-eol`, che azzera il diff). È l'unico
file del repo in questa condizione. Nessuna modifica semantica del fork: è normalizzazione accidentale
(probabilmente `core.autocrlf`). Risultato: conflitto pieno a ogni sync futuro, per contenuto zero.

**Azione.**

```bash
# 1. ripristina i byte esatti di upstream (d996e12 = tip upstream del sync)
git checkout d996e12 -- .github/workflows/ci.yml
git diff --stat d996e12 HEAD -- .github/workflows/ci.yml   # deve essere VUOTO
```

2. Aggiungere in `.gitattributes`, in coda, per impedire che si ri-normalizzi:

```gitattributes
# Fork maintenance: ci.yml è identico a upstream a meno dei line-ending. Una
# normalizzazione accidentale (core.autocrlf sul dev box Windows) lo ha reso un
# conflitto pieno a ogni `git merge upstream/main` per contenuto zero. `-text`
# disattiva ogni conversione EOL in entrambe le direzioni, così il blob committato
# resta byte-identico a quello di upstream e il file smette di comparire nei merge.
.github/workflows/*.yml -text
```

**Nota:** `-text` (non `text eol=lf`). `eol=` agisce solo sul checkout; qui il problema è il *blob
committato*, e serve impedirne la ri-normalizzazione al commit.

**Verifica:** `git diff d996e12 HEAD --name-only` non deve più elencare `.github/workflows/ci.yml`.

Commit: `fix(fork): stop ci.yml from conflicting on every upstream sync`

---

## Step 1b — `Pack & install smoke`: il fork condivide l'identità npm di upstream (decisione richiesta)

**Sintomo.** `scripts/smoke-install.mjs` → `installed surface has 38 core tools, ledger declares 52`.
52 − 38 = esattamente i 14 nomi del fork.

**Causa, riprodotta in locale.** Lo smoke impacchetta il tarball e lo installa in un progetto
temporaneo pulito. `npm install <tarball>` registra la dipendenza come **range semver** (`^0.52.202`)
e poi lo risolve. Il fork mantiene l'identità di upstream — `name: "comfyui-mcp"` e una linea di
versione che insegue la loro — quindi il range matcha il pacchetto pubblicato e npm installa
**quello**, non il nostro tarball:

| | tarball nostro | ciò che npm installa |
|---|---|---|
| versione | 0.52.202 | **0.52.203** |
| `dist/tools/index.js` | 17928 B, importa `../sprite/tools/index.js` | 15235 B, nessun import del fork |
| `dist/sprite/` | 88 file | assente |
| `image-q` nelle dependencies | sì | no |

**Perché è comparso ora.** Date di pubblicazione sul registry: `0.52.202` il 2026-09-07 23:58 UTC,
`0.52.203` il **2026-09-10 02:44 UTC**. Finché la versione più alta pubblicata coincideva con la
nostra, npm si teneva il tarball locale e il check passava. Non è cambiato il branch: è cambiato il
registry. **`main` fallirà allo stesso modo al prossimo run.**

**Non è solo un problema di CI.** Qualunque consumatore che risolva `comfyui-mcp` per nome può
ottenere il pacchetto di upstream al posto di PixelForge — incluso il cold path del plugin
documentato in `CLAUDE.md` (`npx -y comfyui-mcp` in `plugin/scripts/launch-server.mjs`).

**Tre strade, tutte praticabili, la scelta è dell'owner:**

1. **Rinominare il pacchetto** (`pixelforge-mcp`). Risolve alla radice, ma tocca `plugin/.mcp.json`,
   `plugin/scripts/launch-server.mjs` (warm path `npm root -g`, cold path `npx -y`), il workflow
   `npm link` e le istruzioni d'installazione. È un cambio di identità pubblica del progetto.
2. **Sganciare la linea di versione** dal numero di upstream (es. `1.x` del fork). Il range smette di
   matchare le loro release. Meno invasivo, ma il nome resta condiviso e la collisione può tornare.
3. **Blindare solo lo smoke**: installare con `--no-save` e una spec `file:` esatta, in modo che npm
   non registri un range risolvibile. Fix di una riga, ma cura il sintomo in CI e lascia in piedi il
   problema per gli utenti reali.

La 3 rende la CI verde subito e non preclude la 1 o la 2. Le prime due sono decisioni
architetturali: vanno prese, non fatte di passaggio.

Bead: `bd create "Identità npm del fork collide con comfyui-mcp upstream"`

---

## Step 1c — `asset-counts` e `check:docs-locale` (1-2 h)

Due gate rossi **causati dal fork**, che non erano nella prima stesura di questo piano perché non li
avevo eseguiti in locale (`asset-counts` richiede una `dist/` fresca, `check:docs-locale` non lo
avevo lanciato affatto). Entrambi pre-esistenti su `main`.

### `asset-counts` — 13 claim non allineate

`node scripts/asset-counts.mjs --check` confronta i numeri annunciati nella prosa con il registry
reale. Il fork ha portato la superficie da 38 a 52 tool senza rigenerare i testi:

- `docs/plugin.mdx`, `docs/local-vs-comfy-cloud.mdx`, `docs/local-llms.mdx`, `docs/index.mdx`,
  `docs/blog/local-llms-comfyui.mdx` → *"claims 38 for mcp_tools, actual is 52"*. Sono il numero di
  upstream, rimasto lì dopo il sync.
- `README.md` → **7 claim introvabili** (`could not find a claim matching /\*\*(\d+) MCP tools\*\*/`
  e simili). Il fork ha riscritto il README (è un file `merge=ours`) e nel farlo ha eliminato le
  formule che lo script sa verificare. Qui non basta rigenerare: vanno **reintrodotte le frasi**
  nella forma che i regex in `scripts/asset-counts.mjs` riconoscono, oppure va aggiornato lo script.

Procedura: `node scripts/asset-counts.mjs` (senza `--check`) aggiorna ciò che sa aggiornare; le 7
claim del README vanno scritte a mano. Poi ri-verificare con `--check`.

### `check:docs-locale` — 22 problemi strutturali

Tutti su `<locale>/quickstart.mdx`, 11 locale × 2 problemi:

```
✗ <loc>/quickstart: code block #1 was modified — a reader runs this verbatim
✗ <loc>/quickstart: MDX components differ — English [...,Note,...] vs [...senza Note...]
```

Causa: il fork ha modificato `docs/quickstart.mdx` (+10/−4) aggiungendo un `<Note>` e cambiando il
primo code block, **senza propagare alle traduzioni** (`git diff --name-only d996e12 HEAD --
'docs/*/quickstart.mdx'` è vuoto).

Il contenuto non è cosmetico: il `<Note>` avverte che dichiarare `"CIVITAI_API_TOKEN": ""` in
`.mcp.json` **blocca silenziosamente** il caricamento del token da `~/.comfyui-mcp/.env`. Undici
localizzazioni continuano a mostrare la configurazione sbagliata. Vanno aggiornate: stesso `<Note>`
tradotto e stesso code block, in `docs/{ar,es,fa,fr,ja,ko,pt-BR,ru,tr,zh,zh-TW}/quickstart.mdx`.

Verifica: `npm run check:docs-locale` a zero problemi.

Commit suggeriti (separati): `docs: realign advertised asset counts with the 52-tool surface` e
`docs(i18n): propagate the quickstart CIVITAI_API_TOKEN note to every locale`

---

## Step 2 — Bonifica rot nel codice (2-3 h) — **priorità massima**

Sono le stringhe che il modello legge e su cui agisce: le descrizioni e le note dei nostri tool.
Prendi i siti da `/tmp/vocab-worklist.txt` filtrando i path sotto `src/` e
`PixelForgeDocumentations/fork-customization/`. Al momento della stesura erano **~30 siti** così
distribuiti (solo i path, per stimare lo scope — i nomi e i sostituti li dà il gate):

| file | siti |
|---|---|
| `src/sprite/tools/generate-sprite.ts` | 4 (righe 145, 241, 244) |
| `src/sprite/tools/get-sprite-result.ts` | 4 (righe 7, 24, 27, 41) |
| `src/sprite/tools/pixelate-image.ts` | 1 (riga 284) |
| `src/sprite/comfyui/sprite-status.ts` | 4 (righe 15, 68, 70) |
| `src/sprite/comfyui/sprite-job.ts` | 1 (riga 70) |
| `src/sprite/types.ts` | 2 (righe 107, 265) |
| `src/tools/remove-background.ts` | 2 (righe 72, 161) |
| `src/tools/contact-sheet.ts` | 2 (righe 10, 13) |
| `src/services/contact-sheet.ts` | 2 (righe 12, 98) |
| `src/services/view-image.ts` | 1 (riga 17) |
| `src/services/asset-registry.ts` | 1 (riga 219) |
| `src/services/missing-models.ts` | 1 (riga 454) |
| `src/__tests__/tools/assets.test.ts` | 5 (righe 8, 30, 50, 67, 109) |
| `PixelForgeDocumentations/fork-customization/tool-surface.md` | 4 |
| `PixelForgeDocumentations/fork-customization/repo-layout.md` | 1 (riga 7) |

**Come riscrivere.** Vedi "Forma accettata" sopra: sostituisci il nome nudo con il tool vivo più la
sua azione, mantenendo la frase leggibile. Esempio della trasformazione, sul lato buono:

- ✅ `"pass the returned asset_id straight to get_image (action:\"view\")"`

**Casi che richiedono giudizio, non sostituzione meccanica:**

- `get-sprite-result.ts:7` — è un commento che descrive il tool come *"a thin wrapper over the
  INHERITED …"*, cioè racconta la genealogia del codice. Riscrivere comunque nominando il tool
  attuale: ciò che è ereditato è il **servizio**, non il nome del tool. Formulazione suggerita:
  *"a thin wrapper over the inherited job status path (surfaced upstream as `queue (action:\"status\")`)"*.
- `sprite-status.ts:68,70` — verificare se il riferimento è al *tool* o alla funzione interna
  omonima. Se è un identificatore di codice non è rot; ma se il gate lo segnala va comunque
  disambiguato (rinominare la variabile, o riformulare il commento perché non si legga come un
  invito a chiamare un tool).
- `src/__tests__/tools/assets.test.ts` — sono **fixture di test**. Se asseriscono su un nome ritirato
  *come stringa di dato*, il trattamento corretto è `allowedIn` in `vocabulary.ts` con
  `path`/`context`/`why`, **non** riscrivere l'asserzione. Il precedente da copiare come forma sta a
  `src/tools/vocabulary.ts:2249-2263`. Leggere il test prima di decidere.
- `src/services/view-image.ts`, `src/services/contact-sheet.ts`, `asset-registry.ts`,
  `missing-models.ts` — sono file *upstream* che il fork ha modificato. Verificare con
  `git diff d996e12 HEAD -- <file>` se la riga segnalata è nostra o loro. **Se è nostra: correggila.**
  Se è di upstream, è un bug loro → annotarlo per lo Step 6 (candidato a micro-PR separata).

**Verifica:** il conteggio del gate deve calare di ~30 (restano expert docs + storici).
`npm run lint && npm test`.

Commit: `fix(sprite): tool descriptions name the post-0.50.0 surface, not retired names`

---

## Step 3 — Bonifica rot nei prompt dei subagent (30 min)

14 siti, quasi tutti sullo stesso nome (il job-status ritirato in 0.49.0), più due su un lettore
di metadati asset ritirato in 0.50.0. Il gate li nomina; qui bastano i path:

| file | righe |
|---|---|
| `.claude/agents/comfyui-integration-specialist-{opus,sonnet}.md` | 11, 40 |
| `.claude/agents/mcp-protocol-architect-{opus,sonnet}.md` | 15, 26 |
| `.claude/agents/typescript-architecture-specialist-{opus,sonnet}.md` | 42 |
| `.clinerules/workflows/comfyui-integration-specialist.md` | 16 |
| `.clinerules/workflows/mcp-protocol-architect.md` | 20, 31 |
| `.clinerules/workflows/typescript-architecture-specialist.md` | 47 |

**Attenzione all'accoppiamento:** i file `.claude/agents/*-opus.md` e `*-sonnet.md` sono coppie che
devono restare allineate (CLAUDE.md: *"never dispatch to a bare (non-tiered) domain name"*), e
`.clinerules/workflows/*.md` ne sono i mirror senza tier. **Ogni modifica va replicata su tutti e tre
i file della stessa famiglia.** Verifica finale:

```bash
diff <(sed 's/-opus//;s/model: opus//' .claude/agents/mcp-protocol-architect-opus.md) \
     <(sed 's/-sonnet//;s/model: sonnet//' .claude/agents/mcp-protocol-architect-sonnet.md)
```

I prompt dei subagent sono in **inglese** (convenzione non negoziabile, CLAUDE.md).

Commit: `docs(agents): retire dead tool names from specialist prompts`

---

## Step 4 — Esenzioni HISTORICAL motivate (20 min)

23 riferimenti in file che sono **dati storici**: riscriverli falsificherebbe il record.

In `scripts/check-tool-vocabulary.mts`, nell'array `HISTORICAL` (righe ~65-73), aggiungere **due
regex letterali e strette**, ciascuna con la propria motivazione nel commento — nello stile
dell'esenzione già presente per `packs/*/workflow.json`:

```ts
  // Il log append-only delle interazioni beads è DATO, non guida: registra quali
  // tool furono effettivamente chiamati in una sessione passata. Riscriverlo
  // falsificherebbe il record e corromperebbe l'export che `bd` rilegge — stesso
  // argomento dei workflow salvati sopra. Regex sul file esatto, mai su `.beads/`.
  /^\.beads\/interactions\.jsonl$/,
  // Gap report DATATI: snapshot dell'ambiente ComfyUI al 2026-08-02, che
  // documentano quali tool furono eseguiti quel giorno e con che esito. Sono
  // referti, non istruzioni: nessuno li legge per sapere cosa chiamare oggi, e
  // riscriverli cambierebbe cosa risulta essere stato misurato. Il nome del file
  // porta la data, quindi la regex non può catturare documentazione viva.
  /^PixelForgeDocumentations\/PixelForge_Gap_Report_[0-9-]+.*\.md$/,
```

**Vincoli da rispettare:**
- Non aggiungere `PixelForgeDocumentations/` come glob: quella directory contiene guida viva
  (`fork-customization/`, `backlog-proposals.md`), che deve restare sotto gate.
- Per prudenza, aggiungere in testa a entrambi i Gap Report un banner di una riga:
  `> Snapshot datato 2026-08-02. I nomi di tool citati sono quelli in vigore allora; molti sono stati ritirati nella consolidation 0.50.0.`

**Verifica:** il gate non deve più elencare `.beads/interactions.jsonl` né i Gap Report.

Commit: `chore(vocabulary): exempt dated snapshots and the beads interaction log`

---

## Step 5 — Riscrittura `pixelforge-expert-{opus,sonnet}.md` (~1 giornata)

**Cosa sono.** 539 righe, `PixelForgeDocumentations/agents/`. Agente power-user **autoportante**,
progettato per essere copiato in `.claude/agents/` di qualunque progetto senza accesso al repo
PixelForge. Struttura: Parte 1 = pipeline sprite (8 tool), Parte 2 = superficie ComfyUI completa.
I due file sono **byte-identici tranne `name:` e `model:`** (verificato).

**Perché è guida viva e non può essere esentata.** 183 riferimenti a nomi morti ciascuno significano
366 istruzioni che, se l'agente le esegue, ottengono un redirect 404. È esattamente il failure mode
che il gate esiste per prevenire.

**Procedura.**

1. Generare la superficie reale corrente:
   ```bash
   npm run build        # tools:dump richiede dist/
   npm run tools:dump > /tmp/surface-current.json
   ```
   `scripts/tools-dump.mts` fa introspezione **attraverso il vero McpServer** (`src/tools/introspect.ts`),
   quindi restituisce nome + descrizione + inputSchema *come li vede un client* — non una lista
   dedotta. È la sola fonte di verità accettabile qui.
   Riferimenti secondari: `docs/design/tool-surface.txt` (i 52 nomi in ordine di registrazione) e
   `docs/tools/*.mdx` (generati dagli schemi).

2. **Riscrivere `pixelforge-expert-opus.md`:**
   - **Parte 1 (pipeline sprite)** — sostanzialmente valida, va solo bonificata dai nomi morti e
     allineata a `fork-customization/tool-surface.md`. Ricordare che i tool sono **10**, non 8:
     agli 8 MVP si aggiungono `workflow_from_prompt_spec` e `get_workflow_prompt_template`.
   - **Parte 2 (superficie ComfyUI)** — riscrittura vera. La vecchia parte elencava ~120 tool
     singoli; oggi sono ~42 tool action-parameterized. Organizzare **per tool, con le sue azioni**
     invece che un tool per riga: `get_image`, `generate_image`, `queue`, `download_model`,
     `install_comfyui`, `get_system_stats`, `enqueue_workflow`, `create_workflow`… L'elenco esatto
     delle azioni di ciascuno **non va scritto a memoria**: leggilo da `/tmp/surface-current.json`.
   - Aggiornare la sezione "Before doing real work": i tre probe d'ambiente che cita sono tutti
     ritirati. Sostituirli con `get_system_stats (action:"health")` e
     `install_comfyui (action:"environment")` / `workspace`.
   - **Aggiungere una sezione nuova** su ciò che il sync ha reso disponibile e che l'agente deve
     conoscere: `kitchen` (probe GPU/triton), `batch` (sweep multi-job), `train_*` +
     skill `train-character-lora`, `contact_sheet` per la QA visiva.
   - Il file è in **inglese**.

3. **Derivare il sonnet:** copiare l'opus e cambiare solo `name:` e `model:`. Verificare con il `diff`
   dello Step 3.

4. Se durante la riscrittura emergono nomi che non esistono più *e non hanno sostituto*, non
   inventarli: interrogare `/tmp/surface-current.json`.

**Verifica:** `npm run check:vocabulary` deve arrivare a **0 riferimenti** (gate verde) — questo è lo
step che chiude il ciclo.

Commit: `docs(agents): rewrite pixelforge-expert against the post-consolidation surface`

---

## Step 6 — PR upstream: `luma_key` come sonda (mezza giornata + attesa)

**Perché questa e non altre.** È l'unico candidato che **aggiunge zero nomi di tool** (è un nuovo
`mode` su un'action esistente), quindi non collide con `MAX_TOOLS`/`TOOL_BUDGET_TARGET = 30`. Ha
esattamente la forma delle 3 PR esterne che upstream ha mergiato negli ultimi 37 giorni. E porta
valore generico: risolve i due failure mode reali di BiRefNet (riempie i centri cavi di nero opaco,
mangia l'alone emissivo) usando **soli nodi core ComfyUI**, senza dipendenza da custom node.

**Preliminare obbligatorio.** `CONTRIBUTING.md`: *"Open a GitHub issue first for large or potentially
breaking changes"*. Con un manutentore a ~46 commit/giorno, **aprire prima l'issue** descrivendo il
problema (BiRefNet su arte neon-su-nero) e la soluzione proposta, e attendere un cenno. Non aprire la
PR a freddo.

**Contenuto della PR** (da estrarre dal fork, non da riscrivere):

| file | cosa |
|---|---|
| `src/services/workflow-composer.ts` | 2 hunk: campi `mode`/`threshold`/`softness` su `RemoveBackgroundParams`, e la funzione `buildRemoveBackgroundLumaKey` (~89 righe, già commentata incluso il TRAP su `JoinImageWithAlpha` che calcola `alpha = 1.0 - mask`) |
| `src/services/remove-background.ts` | 4 hunk, +53/−14: dispatch birefnet/luma_key |
| `src/tools/generate-image.ts` | **da scrivere ex novo**: esporre `mode`/`threshold`/`softness` sull'action `remove_background` esistente. Il fork li espone solo sul proprio tool standalone, che upstream non ha. |
| `src/__tests__/services/remove-background.test.ts` | i test del fork, già scritti |
| `docs/` | `npm run docs:gen` e committare il rigenerato (gate CI di upstream) |

**Cosa NON includere:** il tool standalone `remove_background`, la risoluzione `asset_id`/`path`
(dipende da `resolveReferenceImage` in `src/sprite/`), qualunque riferimento a PixelForge o sprite.
La PR deve leggersi come un miglioramento di comfyui-mcp, perché lo è.

**Meccanica:** fork pulito di `artokun/comfyui-mcp` (non questo repo), branch `feat/remove-bg-luma-key`,
Conventional Commit, `npm run build && npm test` verdi prima di aprire.

**Candidati successivi**, solo se questa PR viene accolta — una alla volta, mai in blocco:
1. statistiche alpha in `src/services/color-analysis.ts` (+50) — upstream **le cita già** nella
   descrizione di `get_image (action:"analyze_color")`;
2. `saveWorkflowToLibrary` estratto in `src/services/workflow-converter.ts` (+83) — de-duplica la loro
   save path;
3. `ResolveDeps` live in `src/services/missing-models.ts` (+60) — espansione HF `/tree/main` con
   size/precision/fit verdict, inclusa la nota verificata sul perché `?blobs=true` dà 400;
4. `contact_sheet` — **da proporre come `get_image (action:"contact_sheet")`**, mai come tool nuovo.

---

## Step 7 — Design doc: consolidamento della sprite surface (mezza giornata, solo carta)

**Nessun codice.** `locked-decisions.md` impone conferma esplicita prima di rovesciare la "MVP surface
locked": questo step produce il documento su cui decidere, non la decisione.

Creare `PixelForgeDocumentations/fork-customization/tool-surface-consolidation.md` con:

1. **Il vincolo, con le prove.** `MAX_TOOLS = 52` asserito *uguale* a `TOOL_NAMES.length`
   (`vocabulary.ts:219`), `TOOL_BUDGET_TARGET = 30` (`:222`), e la motivazione scritta da upstream
   ("Glama scores Tool Count 1/5 at 148+ tools"). Il fork contribuisce 14 dei 52 nomi.
2. **La mappa di consolidamento proposta**, 14 → ~7:
   - `generate_sprite` + `generate_animation_set` + `generate_arcade_topdown_set` +
     `get_sprite_result` → `sprite (action: "generate"|"animation_set"|"arcade_topdown"|"result")`
   - `workflow_from_prompt_spec` + `get_workflow_prompt_template` → `prompt_spec (action: "compile"|"template")`
   - `get_secrets` + `set_secret` + `clear_secret` → `secrets (action: "get"|"set"|"clear")`
   - `contact_sheet` → azione su `get_image` (allineato allo Step 6, candidato 4)
   - restano standalone: `pixelate_image`, `pack_spritesheet`, `export_for_engine`, `remove_background`
3. **Costo di migrazione:** `TOOL_NAMES` + `MAX_TOOLS` + `DEAD_NAMES` (i vecchi nomi fork diventano
   redirect), `tool-surface-filter.ts` (le tre liste), `docs:gen`, `vocab:export`, i test di superficie,
   e ogni descrizione che nomina un tool sprite. Stimare in file toccati.
4. **Il rischio del non fare nulla:** al prossimo giro di consolidation upstream, i nostri nomi sono
   l'unica ragione per cui il ratchet non chiude, e la decisione arriva sotto merge conflittuale.
5. **Il vincolo di forma da rispettare:** lo shape deve essere un **oggetto piatto con enum `action`**,
   mai `z.discriminatedUnion` — l'SDK MCP renderizza quest'ultimo con zero parametri visibili,
   nascondendo ogni input al modello (`src/tools/system-stats.ts:23-26`).
6. **Effetto collaterale positivo:** 14 → 7 è anche la forma che renderebbe una eventuale PR upstream
   della superficie sprite *discutibile* invece che automaticamente fuori policy.

Aggiornare `fork-customization/INDEX.md` con il link. **Non** modificare `locked-decisions.md` finché
la decisione non è presa.

Commit: `docs(fork): record the sprite tool-surface consolidation decision`

---

## Verifica end-to-end

Al termine di ogni step, e obbligatoriamente prima del push finale:

```bash
npm ci
npm run lint     # tsc --noEmit + anti-slop
npm run build    # necessario prima di npm test: asset-counts legge dist/
npm test         # ombrello: vitest + ~12 gate, con SUMMARY finale
```

**Leggere il SUMMARY, non solo l'exit code.** `npm test` è `node scripts/run-checks.mjs`: esegue
vitest *e* la maggior parte dei gate, e stampa alla fine l'elenco di quelli falliti. Un exit code 1
può voler dire "un gate è rosso" con tutti i test verdi — nel run 34451044623 era esattamente così.
Il SUMMARY deve arrivare a:

```
✅ vitest ... ✅ check:vocabulary ✅ asset-counts ✅ check:docs-locale
```

I due gate che `npm test` **non** copre vanno lanciati a parte:

```bash
node scripts/smoke-install.mjs                      # ← rosso finché lo Step 1b non è deciso
npm run docs:gen && git diff --exit-code -- docs/   # deve essere un no-op
```

Per isolare un singolo gate durante il lavoro: `npm run check:vocabulary`,
`npm run check:docs-locale`, `node scripts/asset-counts.mjs --check`.

**Verifica funzionale del comportamento (non solo dei gate).** Il punto dello Step 2 è che il modello
smetta di chiamare tool morti. Dopo il build, in Claude Code:

1. `/mcp` per riconnettere il server.
2. Chiedere: *"genera uno sprite di un serpente pixel art, poi mostrami il risultato"*.
3. Confermare che l'agente, dopo `generate_sprite`, chiami **`get_image (action:"view")`** e non il
   viewer ritirato che il gate segnalava per quel file. Se chiama ancora il nome morto, una
   descrizione è rimasta indietro.
4. Idem per `remove_background`: deve indirizzare a **`upload_image (action:"stage")`**, non al tool
   di staging ritirato.

Ricordare il **Plugin File Sync** (CLAUDE.md): il plugin gira da
`~/.claude/plugins/cache/pixelforge-mcp/pixelforge/<version>/`. Dopo modifiche in `plugin/` copiare
là e riavviare; per i soli tool MCP basta `npm run build` + `/mcp`.

---

## Ordine di esecuzione e stima

| # | step | stima | dipendenze |
|---|---|---|---|
| 0 | Setup + bead | 5 min | — |
| ~~1~~ | ~~`ci.yml` / `.gitattributes`~~ **✅ fatto (`aadf5e4`)** | — | — |
| **1b** | **Identità npm (`Pack & install smoke`)** | **decisione + 10 min–1 g** | **bloccato: serve una scelta dell'owner** |
| **1c** | **`asset-counts` + `check:docs-locale`** | **1-2 h** | — |
| 2 | **Rot nel codice** | 2-3 h | — |
| 3 | Rot nei prompt subagent | 30 min | — |
| 4 | Esenzioni HISTORICAL | 20 min | — |
| 5 | Riscrittura expert docs | ~1 giorno | Step 2 (per coerenza di formulazione) |
| 6 | PR upstream `luma_key` | ½ giorno + attesa | indipendente, può partire in parallelo |
| 7 | Design doc consolidamento | ½ giorno | indipendente |

Step 1, 1c, 2, 3 e 4 chiudono tre dei quattro rossi in circa una giornata. Lo Step 5 porta
`check:vocabulary` a zero. Lo **Step 1b resta l'unico bloccante che non dipende da lavoro ma da una
decisione**: finché non è presa, `Pack & install smoke` resta rosso su ogni PR e su `main`.

---

## Cosa NON fare

- **Non** allargare `HISTORICAL` oltre le due regex dello Step 4. Se il gate resta rosso su un file di
  guida viva, il file va corretto, non esentato.
- **Non** toccare `TOOL_NAMES`, `MAX_TOOLS`, `BASELINE_SHA256`, `PANEL_BASELINE_SHA256`: nessuno step
  qui cambia la superficie. Un baseline rosso significa che qualcosa è andato storto.
- **Non** implementare `consistency_mode: "controlnet_pose"` in questo piano, anche se il sync ha reso
  disponibili entrambi i prerequisiti (`generate_image (action:"controlnet"/"ip_adapter")` e i tool
  `train_*` + skill `train-character-lora`). Resta una decisione bloccata da `locked-decisions.md`.
- **Non** aggiornare `backlog-proposals.md` sullo scene-splitting in questo piano. Va fatto, ma è
  lavoro separato: la premessa del documento è obsoleta (SAM3 è ora core in `comfy_extras` —
  `SAM3_VideoTrack`/`SAM3_TrackToMask` — quindi il blocco su `triton`/ComfyUI-RMBG non esiste più, e
  il checkpoint `sam3.1_multiplex_fp16` è provisionabile via `apply_manifest` su `packs/artokun-flow`).
  Aprire un bead a parte.
- **Non** modificare `plugin/.mcp.json` per puntare a un path locale (CLAUDE.md lo vieta
  esplicitamente).
- **Non** aprire PR su `Estrusco/pixelforge-mcp` senza richiesta esplicita. Lo Step 6 riguarda una PR
  su `artokun/comfyui-mcp`, che è un repo diverso e richiede un fork separato.
