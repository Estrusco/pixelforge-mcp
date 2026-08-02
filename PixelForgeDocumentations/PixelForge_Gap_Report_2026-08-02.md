# PixelForge — Report dei limiti incontrati (batch sperimentale 10 sprite)

Data: 2026-08-02
Contesto: generazione di 10 sprite pixel-art neon per Mathaconda tramite MCP `pixelforge`.
Ambiente: ComfyUI 0.29.2, Python 3.12.10, PyTorch 2.13.0+cu130, RTX 5060 Laptop 8 GB,
workspace `D:\AIVideo\Data\Packages\ComfyUI` (rilevato dai log, NON configurato lato MCP).

Questo documento elenca **solo ciò che mi ha bloccato o costretto a workaround**, con l'obiettivo
di far evolvere PixelForge. Ordinato per impatto.

---

## 1. Modelli mancanti (impatto: ALTO — ha cambiato tutta la pipeline)

### 1.1 Nessuna LoRA pixel-art
`list_local_models(loras)` restituisce solo:
- `Lora\SDXL_ChaosFeelConcept_Lora_v1.safetensors`
- `Lora\merged_zit_v5.safetensors`
- `illustration-1.0-qwen-image.safetensors`

Nessuna LoRA pixel-art (tipo `nerijs/pixel-art-xl`). Nessun checkpoint pixel-art dedicato.

### 1.2 SDXL base 1.0 è inadeguato al brief
Con `sd_xl_base_1.0_0.9vae.safetensors` (unico SDXL disponibile) e i prompt del technical-artist,
tutti i test hanno prodotto **detail explosion** invece di oggetti singoli e semplici:
- "glowing orb sphere, single object" → mandala sci-fi che riempie tutto il frame
- "two vertical bars pause symbol" → muro di pannelli UI
- "circular portal gate" → tilemap quadrata di architettura
- "2x2 grid of four operator symbols" → tileset casuale su fondo arancione (nemmeno nero)

Il soggetto riempiva sempre il frame bordo-a-bordo: **nessun margine di sfondo**, quindi nemmeno
utilizzabile per il ritaglio alpha. Aderenza al prompt sostanzialmente nulla su "single/simple/centered".

### 1.3 Fallback adottato: Flux-schnell
`flux1-schnell-fp8.safetensors` ha risolto tutto: oggetto singolo, centrato, fondo nero pulito,
colori richiesti rispettati. **Tutti e 10 gli sprite finali sono Flux-schnell**, non SDXL.

### 1.4 ControlNet: cartella vuota
`health_check` segnala `controlnet: **EMPTY** ⚠️`. Non serviva per questo task, ma preclude
qualsiasi lavoro futuro di pose/composizione controllata.

### 1.5 Modelli che varrebbe la pena far auto-scaricare
| Cosa | Perché |
|---|---|
| LoRA `nerijs/pixel-art-xl` (SDXL) | l'unica cosa che rende gli style `8bit/16bit/32bit` reali a livello di generazione |
| Un checkpoint **SD1.5** qualsiasi | gli style `8bit/16bit/32bit` mappano su famiglia sd15 (vedi §2.2) e qui non esiste nessun sd15 |
| ControlNet SDXL (canny/depth) | cartella vuota |
| BiRefNet | OK — si è auto-scaricato al primo uso, comportamento ideale da replicare |

---

## 2. Gap funzionali di PixelForge (impatto: ALTO)

### 2.1 `pixelate_image` inutilizzabile per I/O su file senza `COMFYUI_PATH`
`get_workspace` → `workspace_source: "none"`. Conseguenze:

| Input usato | Risultato |
|---|---|
| `path: "..."` | `VALIDATION_ERROR: COMFYUI_PATH is not configured` |
| `out_path: "..."` | `VALIDATION_ERROR: COMFYUI_PATH is not configured` |
| `asset_id: "..."` | funziona, **ma restituisce l'immagine solo inline** |

Con `asset_id` il risultato non viene né scritto su disco né registrato come nuovo asset:
**non è concatenabile con nessun altro tool**. Di fatto `pixelate_image` — il tool centrale della
sprite pipeline — è stato inutilizzabile in questo ambiente.

**Proposte:**
1. Far funzionare `pixelate_image` interamente via API HTTP come fa `get_image` (scarica i byte da
   `/view`), senza dipendere da `COMFYUI_PATH`.
2. Aggiungere `save_dir` (path locale arbitrario) come ha `get_image`.
3. In alternativa minima: **registrare il risultato come asset** così da poterlo passare ad altri tool.

### 2.2 `generate_sprite`: la mappa style→checkpoint assume modelli non presenti
Gli style `8bit/16bit/32bit` puntano alla famiglia **sd15**, ma qui non esiste nessun checkpoint
sd15 — quindi quegli style non sono realmente utilizzabili. Ho dovuto passare `checkpoint` override
a ogni chiamata.

**Proposte:** risolvere il checkpoint sui modelli effettivamente installati; se la famiglia
attesa manca, restituire un errore/warning esplicito ("style 32bit richiede un checkpoint sd15,
nessuno installato: usa checkpoint override o scarica X") invece di procedere silenziosamente.

### 2.3 `generate_sprite` non espone `steps` / `cfg` / `sampler` / `scheduler`
Lo style fissa il profilo di sampling (32bit = 28 step, cfg 7.0, dpmpp_2m/karras). Flux-schnell
richiede **cfg 1.0 e 4-8 step**: con il profilo dello style produce output bruciato/inutile.

Non potendo forzare quei parametri, **ho dovuto abbandonare `generate_sprite` e usare
`generate_image` per tutti e 10 gli sprite**, perdendo i frammenti di prompt style/viewpoint.

**Proposte:** override opzionali dei parametri di sampling, oppure un profilo `flux` nella tabella
degli style (riconoscendo il checkpoint Flux e forzando cfg 1.0).

### 2.4 Manca un tool di alpha da luminanza / color key — `remove_background` è sbagliato per questo tipo di arte
`remove_background` (BiRefNet, salient-object matting) su pixel art neon-su-nero ha due difetti gravi,
entrambi verificati misurando il canale alpha:

1. **Riempie di nero opaco i centri cavi.** Sul portale ad anello, l'interno vuoto risultava
   `A=255, RGB=(0,0,0)` — in Unity avrebbe occluso la griglia neon sotto lo sprite.
2. **Distrugge l'alone glow**: produce un matte duro, mentre il glow emissivo è il cuore della
   direzione artistica.

Ho dovuto costruire a mano un workflow di luminance key con soli nodi core:

```
LoadImage → ImageToMask(red) ┐
          → ImageToMask(green) ├→ MaskComposite(add) → MaskComposite(add) → InvertMask
          → ImageToMask(blue) ┘                                                  ↓
                                         JoinImageWithAlpha(image, alpha) → SaveImage
```

Risultato: fondo e centri cavi trasparenti, glow conservato come alpha morbida
(istogramma tipico: ~48k trasparenti / ~12k semi-trasparenti / ~5.5k opachi).

**Proposte:** aggiungere `remove_background(mode: "birefnet" | "luma_key" | "color_key")`
oppure un tool dedicato `alpha_from_luminance(asset_id, threshold, softness)`.
È il singolo tool che mi avrebbe fatto risparmiare più tempo in questo task.

> **Trappola da documentare:** `JoinImageWithAlpha` applica internamente `alpha = 1.0 - mask`.
> Senza un `InvertMask` prima, l'alpha esce **invertita** (sfondo opaco, soggetto trasparente).
> Ci sono cascato al primo tentativo. Analogamente `LoadImage` restituisce `MASK = 1 - alpha`,
> quindi passare direttamente la MASK di LoadImage a JoinImageWithAlpha è invece corretto.

### 2.5 `pixelate_image` non fa upscale
Produce solo il target (es. 64×64). Il brief chiedeva griglia logica ~64 px ma file finale 128×128
nearest-neighbor: serve un passaggio esterno. **Proposta:** parametro `output_size` / `output_scale`
(es. griglia 64 renderizzata a 128) — è il formato che serve praticamente sempre per Unity.

### 2.6 Nessun modo di ispezionare l'alpha o fare QA visiva di un batch
Per verificare che l'alpha fosse corretta e per giudicare 10 sprite neon insieme ho dovuto usare
PowerShell + System.Drawing (istogramma alpha, contact sheet su fondo scuro).

Nota importante: `view_image` / `get_image` compositano la trasparenza **su bianco**, il che rende
illeggibile la pixel art neon pensata per fondo scuro — a colpo d'occhio sembrava sbiadita/rotta
mentre era corretta.

**Proposte:** `view_image(background: "dark"|"light"|"checker")`; statistiche alpha in
`analyze_color`; un tool `contact_sheet(asset_ids[], background)` per la QA di batch.

### 2.7 `export_for_engine` non applicabile a sprite singoli
Richiede il giro `pack_spritesheet` + `metadata`, ed emette PNG+JSON di slicing — inutile per 10
sprite indipendenti, e comunque non genera il `.meta` Unity. Ho scritto i PNG finali direttamente
con `get_image(save_dir=...)`.

**Proposta:** modalità "single sprite" che scriva PNG (+ eventuale `.meta` Unity con
`spriteImportMode`, `filterMode: Point`, `compression: none`, `pixelsPerUnit`) in un path di progetto.
Per la pixel art il `.meta` con **Point filter + no compression** è ciò che davvero fa risparmiare
lavoro manuale.

### 2.8 `get_image` è l'unico tool che scrive su un path locale arbitrario
È stato l'unico modo per far arrivare i file nel progetto Unity. Ottimo com'è — ma quel `save_dir`
dovrebbe esistere anche su `pixelate_image` e su ogni trasformazione locale.

---

## 3. Conseguenze sul risultato finale (cosa il technical-artist deve sapere)

- **Il negative prompt comune è stato inerte su tutti e 10 i file finali.** Flux-schnell gira a
  cfg 1.0, dove il prompt negativo non ha alcun effetto. Vincoli tipo "no text/no watermark" vanno
  espressi nel prompt positivo. (Si è visto: un tentativo ha prodotto la scritta "SCOFE".)
- **Il pixel look non viene dal modello ma dal post-processing**, come previsto: griglia logica 64 px
  + quantizzazione a 28 colori + nearest 128.
- **Quantizzazione**: non ho potuto usare `palette_mode: auto_kmeans` di `pixelate_image` (§2.1);
  ho usato il nodo core `ImageQuantize(colors=28, dither="none")`. Risultato paragonabile ma
  **senza il passo di despeckle** che `pixelate_image` avrebbe applicato.
- **Alpha**: luma key per gli 8 sprite emissivi; BiRefNet solo per `CrystalShard` e `TechBarrier`
  (corpi solidi scuri, dove il luma key li avrebbe cancellati).

---

## 4. Problemi d'ambiente minori (non PixelForge)

- `python` non è nel PATH di Git Bash → i loop di attesa basati su `python -c json` fallivano
  silenziosamente (uscivano subito). Ho usato `grep` sul JSON di `/queue`.
- `triton` non installato → `ComfyUI-RMBG/AILab_SAM3Segment.py` non carica (warning all'avvio).
  Il resto di ComfyUI-RMBG (42 nodi) funziona.
- VRAM 8 GB: SDXL e Flux-schnell a 1024×1024 girano senza OOM (~35-55 s/immagine).

---

## 5. Riepilogo priorità suggerite per PixelForge

| Prio | Intervento |
|---|---|
| P1 | `pixelate_image` funzionante senza `COMFYUI_PATH` (via API) + `save_dir` + risultato registrato come asset |
| P1 | Modalità alpha **luma/color key** (o tool dedicato) accanto a BiRefNet |
| P2 | Override sampling in `generate_sprite` (o profilo Flux) |
| P2 | Auto-download LoRA pixel-art + un checkpoint sd15; risoluzione style→checkpoint sui modelli reali |
| P3 | `output_size` in `pixelate_image` (griglia logica ≠ dimensione file) |
| P3 | `view_image(background=dark)` + contact sheet + statistiche alpha per la QA |
| P3 | `export_for_engine` modalità single-sprite con `.meta` Unity (Point filter, no compression) |
| P4 | Documentare l'inversione di `JoinImageWithAlpha` / `LoadImage` MASK |
