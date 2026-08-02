# Piano: chiudere i gap del PixelForge Gap Report (Mathaconda, 2026-08-02)

> Piano di implementazione per i gap segnalati in
> [`PixelForge_Gap_Report_2026-08-02.md`](PixelForge_Gap_Report_2026-08-02.md). Non ancora
> eseguito — salvato qui per essere ripreso in una sessione successiva.

## Context

Durante un batch di 10 sprite per Mathaconda, il modello ha usato PixelForge MCP e ha
documentato in `PixelForgeDocumentations/PixelForge_Gap_Report_2026-08-02.md` tutto ciò che lo
ha bloccato o costretto a workaround manuali (nodi ComfyUI a mano, PowerShell per QA alpha,
`generate_image` al posto di `generate_sprite`). Obiettivo di questo piano: chiudere questi gap
nel codice di PixelForge così che il prossimo batch (Mathaconda o altri progetti Unity) fluisca
senza uscire dal tool surface previsto. Segue l'ordine di priorità P1→P4 già proposto nel report
stesso (§5), con due decisioni dell'utente già raccolte:

- **Auto-download modelli/LoRA mancanti**: da wirare come **flag esplicito, mai silenzioso**
  (`auto_download_missing`) dentro `generate_sprite`/`generate_animation_set`, riusando
  `resolve_missing_models` (rilevamento, già read-only) + `download_model`/`download_civitai_model`
  (esecuzione, già esistenti). Questo è già lo scope esatto dell'epic beads esistente
  **pixelforge-mcp-7dc** (`.1` wiring LoRA, `.2` auto-download, `.3` validate-before-enqueue) —
  questo piano lo implementa invece di riprogettarlo da zero.
- **Flux**: solo override espliciti di sampling (steps/cfg/sampler/scheduler) su
  `generate_sprite`, stesso pattern già usato da `generate_image`. Niente nuovo grafo
  UNETLoader/dual-CLIP in questo giro (rimane fuori scope, notato come lavoro futuro).
- **Unity `.meta`**: SÌ, con mitigazione — genera `<file>.png.meta` **solo se il file non esiste
  già** (mai sovrascrivere un `.meta` esistente, per non rompere i GUID referenziati da
  scene/prefab). Aggiorna la locked decision in CLAUDE.md. In più: **rilevamento automatico** se
  `out_path` è dentro un progetto Unity reale (radice con `ProjectSettings/` + path sotto
  `Assets/`), con un override esplicito `generate_meta: boolean` per i casi in cui
  l'euristica sbaglia.

---

## P1 — `pixelate_image`: I/O via HTTP, `save_dir`, registrazione come asset

File: `src/sprite/image-io.ts`, `src/sprite/tools/pixelate-image.ts`, `src/services/asset-registry.ts`.

**Causa radice (confermata leggendo il codice):** `resolveReadablePath`/`resolveWritableOutputPath`
in `image-io.ts` chiamano `resolveOutputDir()` (`src/services/output-dir.ts`), che prova
`/system_stats` via HTTP e ricade su `<COMFYUI_PATH>/output` — che **lancia** se `COMFYUI_PATH`
non è configurato — ogni volta che ComfyUI gira con la directory di output di default (nessun
flag `--output-directory`/`--base-directory`, il caso comune). `asset_id` invece già funziona
senza `COMFYUI_PATH` perché passa da `getOutputImage()` → `/view` HTTP puro
(`src/services/image-management.ts`).

**Fix:**
1. **Lettura via `path` relativo senza `COMFYUI_PATH`**: quando `resolveOutputDir()` non può
   risolvere una directory locale reale (COMFYUI_PATH assente e nessun override rilevato via
   argv), invece di lanciare, trattare il `path` relativo come `filename` (+ `subfolder` se
   contiene `/`) e recuperare i byte via `getOutputImage(filename, "output", subfolder)` (HTTP
   `/view`, stesso meccanismo già usato per `asset_id`). I path assoluti restano invariati (già
   funzionano oggi, non toccano `COMFYUI_PATH`).
2. **Nuovo `save_dir`** su `pixelate_image` (e stesso trattamento su `export_for_engine`, che ha
   la stessa dipendenza da `resolveWritableOutputPath`): directory locale arbitraria, non
   vincolata alla output dir di ComfyUI — stesso pattern di `get_image` in
   `src/tools/image-management.ts` (`mkdir(recursive) + writeFile`, nessuna verifica
   `COMFYUI_PATH`). `out_path` resta per chi vuole esplicitamente scrivere dentro la output dir di
   ComfyUI (comportamento invariato, richiede ancora `COMFYUI_PATH` per i path relativi).
3. **Registrazione come asset**: dopo la quantizzazione, caricare il PNG risultante nella input
   dir di ComfyUI via `uploadImageAuto`/`uploadImageHttp` (HTTP, nessun `COMFYUI_PATH`
   necessario — stesso meccanismo di `upload_image`), poi creare un `AssetRecord` sintetico.
   `AssetRegistry.register()` oggi richiede `promptId` + `workflow` reali (viene chiamato solo da
   `job-watcher.ts` dopo un job ComfyUI vero) — serve un nuovo path di registrazione leggero (es.
   `AssetRegistry.registerLocal({ filename, subfolder, type: "input" })` con un `promptId`
   sintetico tipo `local:<hash>` e un `workflow: {}` vuoto). Documentare che `regenerate` non è
   supportato per asset così registrati (non hanno un workflow reale da rieseguire).

## P1 — `remove_background`: modalità `luma_key` accanto a BiRefNet

File: `src/services/workflow-composer.ts` (`buildRemoveBackground`), `src/services/remove-background.ts`,
`src/tools/remove-background.ts`.

Nessuna violazione della locked decision "background removal sempre delegato a ComfyUI" — è
un grafo diverso, non una reimplementazione locale. Aggiungere:
- Un nuovo `mode: "birefnet" | "luma_key"` (default `"birefnet"`, comportamento invariato) sul
  tool `remove_background`.
- In `workflow-composer.ts`, una nuova funzione di build per il grafo verificato nel report:
  `LoadImage → ImageToMask(red/green/blue) → MaskComposite(add) → MaskComposite(add) →
  InvertMask → JoinImageWithAlpha(image, alpha) → SaveImage`, con `threshold`/`softness` come
  parametri opzionali.
- **Commento esplicito nel codice** (non solo nel report) sulla trappola verificata dall'utente:
  `JoinImageWithAlpha` applica `alpha = 1.0 - mask` internamente, quindi serve `InvertMask` prima
  o l'alpha esce invertita; `LoadImage` restituisce `MASK = 1 - alpha`, quindi la sua MASK va
  passata **direttamente** a `JoinImageWithAlpha` senza invertirla di nuovo. Questo chiude anche
  il P4 del report.

## P2 — Auto-detect + download opzionale dei modelli/LoRA mancanti (epic pixelforge-mcp-7dc)

File: `src/sprite/comfyui/sprite-job.ts` (`enqueueSpriteJob`), `src/sprite/tools/generate-sprite.ts`,
`src/sprite/tools/generate-animation-set.ts`, `src/sprite/comfyui/checkpoint-resolver.ts`.

Implementa **pixelforge-mcp-7dc.2** (auto-download) e, come suo prerequisito naturale,
**pixelforge-mcp-7dc.3** (validate-before-enqueue) — entrambi già figli dell'epic esistente:

1. Nuovo parametro opzionale `auto_download_missing: boolean` (default `false`/assente =
   comportamento invariato) su `generate_sprite` e `generate_animation_set`.
2. Quando `true`, **prima** di `enqueueSpriteJob`: costruire il workflow, chiamare
   `findMissingModels`/`resolveCandidates` (già in `src/services/missing-models.ts`, oggi esposti
   solo via il tool separato `resolve_missing_models`) sul workflow appena costruito. Se non manca
   nulla, procedere come oggi.
3. Se manca un modello: scegliere il miglior candidato (`match === "exact"`, poi `fit === "fits"`)
   e scaricarlo con `downloadModel`/`downloadCivitaiModel` (stesso servizio di
   `download_model`/`download_civitai_model`), riportando nel risultato del tool cosa è stato
   scaricato e da dove — **mai silenzioso**: il flag stesso è la conferma esplicita dell'utente
   (nessuna finestra di dialogo aggiuntiva, coerente con come gli altri tool MCP di questo repo
   già funzionano). Se non si trova nessun candidato valido, restituire un errore azionabile
   (stesso testo che oggi produce `resolve_missing_models`) invece di procedere con un checkpoint
   sbagliato.
4. **7dc.3** (prerequisito): chiamare `validateWorkflow` (`src/services/workflow-validator.ts`,
   oggi esposta solo come tool separato `validate_workflow`) subito prima della submit in
   `enqueueSpriteJob`, così un grafo mal formato (es. dopo un download fallito) viene segnalato
   prima di arrivare a ComfyUI.
5. **pixelforge-mcp-7dc.1** (LoRA wiring) resta fuori da questo giro se non esplicitamente
   richiesto — il report lo cita (§1.5, LoRA `pixel-art-xl`) ma il fix minimo per sbloccare la
   pipeline è l'auto-download del *checkpoint*, non il wiring LoRA nel grafo (che richiede toccare
   `StyleProfile`/`buildSpriteWorkflow` in modo più strutturale). Segnalarlo come follow-up separato
   se si vuole nel dettaglio.

## P2 — Override sampling in `generate_sprite` + warning esplicito su family mismatch

File: `src/sprite/tools/generate-sprite.ts`, `src/sprite/types.ts` (`SpriteJobRequest`),
`src/sprite/comfyui/sprite-workflow.ts`, `src/sprite/comfyui/checkpoint-resolver.ts`.

1. Aggiungere `steps`, `cfg`, `sampler`, `scheduler` come campi **opzionali** allo schema di
   `generate_sprite` — stesso identico pattern già usato da `generate_image`
   (`src/tools/generate-image.ts`, righe 30-33). Propagarli in `SpriteJobRequest` e in
   `buildSpriteWorkflow`, con override-if-present sull'oggetto `shared` (stesso pattern già usato
   per `denoise ?? DEFAULT_SPRITE_DENOISE` in `sprite-workflow.ts:97`): `steps:
   request.stepsOverride ?? profile.steps`, ecc. Questo sblocca direttamente il caso Flux-schnell
   del report (cfg 1.0, 4-8 step) senza toccare la costruzione del grafo.
2. In `resolveSpriteCheckpoint` (`checkpoint-resolver.ts`), quando il fallback finisce su un
   checkpoint di famiglia diversa da quella attesa dallo style (es. style `32bit`/famiglia `sd15`
   ma in libreria c'è solo SDXL), includere nel risultato/echo del tool un **warning esplicito**
   (non solo un `logger.info` interno) — coerente con la richiesta del report di non "procedere
   silenziosamente" quando lo style richiesto non è realmente disponibile.

## P3 — `pixelate_image`: upscale finale (`output_size`/`output_scale`)

File: `src/sprite/postprocess/quantize.ts`, `src/sprite/tools/pixelate-image.ts`.

Dopo il despeckle (`cleaned`, `quantize.ts:92`), se il caller passa `output_size: {width,
height}` o `output_scale: number`, applicare un resize `sharp(...).resize(w, h, {kernel:
"nearest"})` prima del `.png()` finale — nessun impatto sulla griglia logica già quantizzata
(64×64 → 128×128 nearest, esattamente il caso del report).

## P3 — QA: `view_image(background)`, statistiche alpha, `contact_sheet`

File: `src/services/view-image.ts`, `src/tools/assets.ts`, `src/services/color-analysis.ts`,
nuovo tool `contact_sheet` in `src/tools/` (generico, non sprite-specific — non tocca il tool
surface locked di `src/sprite/`).

1. `view_image`: nuovo parametro opzionale `background: "dark" | "light" | "checker"` che
   compone (via `sharp().flatten()`/composite) l'immagine RGBA su uno sfondo scelto prima di
   restituirla — così anche un client che a sua volta compone su bianco (comportamento osservato
   nel report) mostra correttamente pixel art neon-su-nero.
2. `analyze_color`: oggi `toRaw()` chiama `sharp(bytes).removeAlpha()` **prima** di calcolare le
   statistiche — l'alpha viene scartata. Aggiungere una sezione `alpha` (percentuali
   trasparente/semi-trasparente/opaco, bucket 0 / 1-254 / 255) leggendo il 4° canale quando
   presente, senza rimuoverlo a priori.
3. Nuovo tool `contact_sheet(asset_ids[], background, columns?)`: affianca N asset in un'unica
   PNG di anteprima su uno sfondo scelto — per la QA visiva di un batch (i 10 sprite del report),
   sostituendo lo script PowerShell + System.Drawing che l'utente ha dovuto scrivere a mano.

## P3 — `export_for_engine`: modalità single-sprite + `.meta` Unity (con conferma già raccolta)

File: `src/sprite/tools/export-for-engine.ts`, `src/sprite/export/unity.ts` (o nuovo
`src/sprite/export/unity-meta.ts`), `CLAUDE.md` (locked decision da aggiornare).

1. **Single sprite**: nessun nuovo codice di packing — un `pack_spritesheet` a 1 frame già
   produce una `SpritesheetMetadata` valida che `export_for_engine` accetta oggi senza modifiche
   (verificato: `packSpritesheet` rifiuta solo `frames.length === 0`, nessun minimo > 1). Il fix è
   solo di **documentazione/ergonomia**: la description del tool deve dire esplicitamente che un
   singolo sprite è un pacchetto a 1 frame, non un caso non supportato.
2. **`.meta` Unity**, con la mitigazione concordata:
   - Rilevare se `out_path` (quando assoluto, o risolto) sta dentro un progetto Unity reale:
     risalire dalla directory del file cercando un ancestor con una cartella `ProjectSettings/`
     sorella di `Assets/`, e verificare che il file finisca sotto `Assets/`. Se rilevato, default
     `generate_meta = true`; altrimenti default `false`.
   - Nuovo parametro esplicito `generate_meta: boolean` per forzare l'euristica in entrambe le
     direzioni quando sbaglia.
   - **Mai sovrascrivere un `.meta` già esistente** — se `<out_path>.meta` esiste già, saltare la
     scrittura e segnalarlo nel risultato (nessun rischio di rompere GUID referenziati).
   - Contenuto del `.meta`: `TextureImporter` con `textureType: Sprite`, `spriteImportMode:
     Single`, `filterMode: Point` (0), `textureCompression: None`, `spritePixelsPerUnit:
     pixels_per_unit`, GUID generato una sola volta alla creazione.
   - Aggiornare la locked decision in `CLAUDE.md` ("Unity export is PNG + JSON only in MVP — no
     `.meta` generation") per riflettere il nuovo comportamento e la mitigazione.

## Fuori scope (documentato, non azionabile lato PixelForge)

- §4 del report (python non in PATH di Git Bash, `triton` mancante per `AILab_SAM3Segment.py`,
  VRAM 8GB senza OOM) — problemi d'ambiente dell'utente, nessuna azione lato codice.
- §3 (negative prompt inerte a cfg 1.0 su Flux-schnell) — conseguenza nota di come funziona
  Flux, non un bug: da menzionare nella description dei parametri sampling override aggiunti
  sopra (P2), così il vincolo emerge dalla documentazione del tool invece che scoprirlo di nuovo
  sul campo.

---

## Verifica

- Suite di test esistente (`npm test` — il repo ha `src/__tests__/` con test per
  `output-dir`, `list-output-images`, `export-for-engine`, ecc.): estendere con casi per ogni
  fix (path relativo senza `COMFYUI_PATH` → HTTP fallback; `save_dir` non vincolato; asset
  sintetico registrato e riutilizzabile da `remove_background`/`pack_spritesheet`; `luma_key`
  produce l'alpha nel verso giusto su un'immagine di test con centro cavo; override sampling
  effettivamente sovrascrivono il profilo di style; `.meta` non scritto se già esistente).
- Verifica end-to-end manuale con ComfyUI locale attivo (workspace NON configurato via
  `COMFYUI_PATH`, replicando l'ambiente del report): `generate_sprite` → `pixelate_image` (via
  `asset_id`, poi via `path` relativo) → `remove_background(mode: "luma_key")` →
  `pack_spritesheet` (1 frame) → `export_for_engine` con `out_path` dentro un progetto Unity di
  prova, verificando che compaia `<file>.png.meta` solo se assente.
- `bd close` sui figli di `pixelforge-mcp-7dc` mano a mano che vengono implementati; l'epic
  stesso resta aperto finché non sono chiusi tutti e tre.
