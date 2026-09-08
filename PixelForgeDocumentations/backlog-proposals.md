# Backlog proposals (pre-bead)

> Note volanti raccolte in sessioni dove `bd` non era disponibile (es. sessioni Claude Code on
> the web, dove l'installer di beads è bloccato dalla policy dell'ambiente). Quando si lavora da
> una macchina con `bd` configurato, convertire ogni voce in un bead con `bd create` e poi
> rimuoverla da qui.

## Estrazione multi-oggetto da immagine composita ("scene splitting")

**Richiesta originale:** data un'immagine composita (es. uno screenshot di UI di gioco con più
elementi — HUD, icone, personaggi, sfondo), un tool che estragga automaticamente i singoli
oggetti che la compongono, uno per file, ciascuno come sprite indipendente.

**Stato attuale:** non esiste. I tool di taglio/isolamento esistenti fanno altro:
- `remove_background` isola **un solo** foreground dallo sfondo (modalità `birefnet` o
  `luma_key`), non oggetti multipli.
- `pack_spritesheet` fa l'operazione inversa: impacchetta frame già separati in un unico foglio.

Nessun tool copre "N oggetti in 1 immagine → N file separati".

**Mattone già disponibile:** il pacchetto ComfyUI-RMBG (già installato, usato da
`remove_background`) include un nodo di segmentazione a istanze (`AILab_SAM3Segment`, basato su
SAM3). Nel report d'ambiente (`PixelForge_Gap_Report_2026-08-02.md`, §4) risulta **non caricato**
per dipendenza `triton` mancante (solo warning all'avvio — gli altri 42 nodi RMBG funzionano).
Sistemare quella dipendenza è il prerequisito per avere una vera segmentazione a istanze
disponibile in ComfyUI.

**Possibile design (nuovo tool, non un'estensione di `remove_background`):**
1. `LoadImage` → nodo di segmentazione a istanze (SAM3 via ComfyUI-RMBG, una volta risolto
   `triton`; in alternativa GroundingDINO+SAM per detection guidata da testo) → N maschere.
2. Per ciascuna maschera: crop al bounding box + alpha dalla maschera (stesso principio di
   `remove_background`, ripetuto per istanza).
3. Salvataggio di ogni crop come file/asset separato (stesso pattern `save_dir` +
   re-upload/registrazione asset di `pixelate_image`).

**Caveat aperto:** SAM/SAM3 segmenta bene oggetti naturali/fotorealistici a bordi netti; su UI
piatta con elementi sovrapposti e testo incorporato nella texture (es. numeri scolpiti in una
cornice) la qualità è incerta. Prima di investire nel tool andrebbe fatto un piccolo esperimento
manuale via ComfyUI con `AILab_SAM3Segment` su un'immagine di questo tipo, per capire se la
qualità di output è accettabile.

**Perché non è già un bead:** è una capability nuova, fuori dagli 8 tool bloccati della MVP
surface (`tool-surface.md`) — per `locked-decisions.md` va confermata esplicitamente prima di
partire, non è un'estensione naturale di un tool esistente.
