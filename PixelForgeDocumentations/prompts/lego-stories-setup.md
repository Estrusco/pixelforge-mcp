# Prompt di setup — progetto "Lego Stories"

Prompt da incollare come **primo messaggio** in una sessione Claude Code pulita, aperta in una
cartella di progetto nuova e vuota. Installa il plugin PixelForge a livello di progetto e crea
agenti specializzati per produrre filmati ComfyUI che partono da foto reali di costruzioni LEGO e
sfumano in animazioni in stile LEGO, sincronizzate su una narrazione audio.

Prerequisiti: `D:\Dev\pixelforge-mcp` già compilato (`npm install && npm run build && npm link`),
ComfyUI (Stability Matrix) in esecuzione, `ffmpeg` nel PATH.

Note di design:
- Gli agenti in `.claude/agents/` di questo repo sono specifici per sprite/pixel art/Unity: il
  prompt **non** li copia, ne crea di nuovi per il dominio video seguendo la stessa struttura
  (orchestrator + coppie sonnet/opus, prompt in inglese).
- La pipeline video sfrutta quello che il plugin offre già: skill `director` e comando
  `/pixelforge-director` (Z-Image → Qwen Edit → WAN 2.2 FLF → ffmpeg), più `wan-flf-video`,
  `ltxv2-video`, `video-extend`, `video-upscale`, `qwen-image-edit`, `train-character-lora`.

---

````markdown
# Setup progetto: "Lego Stories" — video ComfyUI dalle costruzioni LEGO di mio figlio

## Contesto
Questo è un progetto NUOVO e vuoto. Voglio usarlo per produrre brevi filmati con ComfyUI:
ogni filmato parte da una FOTO REALE di una costruzione LEGO fatta da mio figlio e sfuma
in un'animazione in stile LEGO (brickfilm / stop-motion), che racconta una storia. La storia
la scriverò io più avanti e sarà narrata con la voce registrata di mio figlio: l'audio guida
il montaggio.

Per la generazione usiamo **PixelForge MCP**, un mio fork di `artokun/comfyui-mcp`, che si trova in
`D:\Dev\pixelforge-mcp` (già compilato e collegato con `npm link`). ComfyUI gira in locale
tramite Stability Matrix.

In questa sessione devi SOLO preparare il progetto. Non generare immagini né video finché non
te lo chiedo esplicitamente.

## Fase 0: verifica ambiente (fermati e chiedimi se qualcosa non torna)
1. Controlla di poter leggere `D:\Dev\pixelforge-mcp`. Se non hai accesso, chiedimi di eseguire
   `/add-dir D:\Dev\pixelforge-mcp` e aspetta.
2. Leggi in quel repo: `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
   `plugin/.mcp.json`, `plugin/skills/director/SKILL.md`, `plugin/commands/director.md`,
   `plugin/skills/wan-flf-video/SKILL.md`, `.claude/agents/orchestrator.md` e uno degli agenti
   `*-sonnet.md` / `*-opus.md` (ti servono come modello di struttura).
3. Verifica che `comfyui-mcp` risolva (`npm root -g` → `comfyui-mcp/dist/index.js`) e che
   `ffmpeg` sia nel PATH. Segnalami cosa manca, senza installare nulla da solo.
4. NON modificare nulla dentro `D:\Dev\pixelforge-mcp`. È un altro repo: lì si legge e basta.

## Fase 1: installa il plugin PixelForge a livello di progetto
Crea `.claude/settings.json` nel progetto con il marketplace locale e il plugin abilitato:

```json
{
  "extraKnownMarketplaces": {
    "pixelforge-mcp": {
      "source": { "source": "directory", "path": "D:\\Dev\\pixelforge-mcp" }
    }
  },
  "enabledPlugins": { "pixelforge@pixelforge-mcp": true }
}
```

Poi dimmi di riavviare Claude Code (oppure di eseguire `/plugin marketplace add D:\Dev\pixelforge-mcp`
e `/plugin install pixelforge@pixelforge-mcp` se il plugin non compare). Dopo il riavvio verifica
con `/mcp` che il server `pixelforge` sia connesso e che i suoi tool rispondano (ad esempio
elencando i modelli disponibili in ComfyUI). Non copiare il plugin nel progetto e non toccare `.mcp.json`.

## Fase 2: struttura del progetto
Crea queste cartelle:

```
lego-photos/        # foto originali delle costruzioni (le aggiungo io) — MAI modificarle
  _catalog.md       # scheda per ogni costruzione: nome, colori, pezzi distintivi, personaggi
story/              # testo della storia + scene plan (story.md, scenes.json)
audio/
  raw/              # registrazioni originali di mio figlio — MAI modificarle
  processed/        # audio pulito/normalizzato, trascrizione con timestamp
refs/               # character sheet / reference generate per la consistenza
frames/             # start/end frame per scena
clips/              # clip video per scena
renders/            # montaggi finali (video + audio)
state/              # file di stato della pipeline (ripresa dopo compattazione/riavvio)
```

Aggiungi un `.gitignore` che escluda dal versionamento `lego-photos/`, `audio/`, `frames/`,
`clips/` e `renders/`. Sono contenuti personali di un minore: non devono MAI finire su un remote,
né su Civitai o su altri servizi esterni. Tutto resta in locale.

## Fase 3: agenti specializzati per questo progetto
Crea gli agenti in `.claude/agents/` seguendo la STESSA struttura degli agenti PixelForge che hai
letto: un `orchestrator.md` come punto d'ingresso e ogni dominio come coppia `-sonnet` / `-opus`,
con frontmatter `name`, `description`, `model`, `tools`. Il corpo dei prompt deve essere in
**inglese**. Non copiare gli agenti sprite/Unity: scrivili nuovi, per questi domini.

1. **lego-reference-analyst**: analizza le foto in `lego-photos/` e compila `_catalog.md`
   (forma, colori dominanti, pezzi riconoscibili, scala, eventuali minifigure). Decide quale foto è
   adatta come primo frame: luce, sfondo, inquadratura. Propone crop/pulizia senza mai alterare
   l'originale; lavora su copie.
2. **story-director**: trasforma la mia storia e la trascrizione dell'audio in un piano scene
   (`story/scenes.json`): per ogni scena descrizione, durata derivata dai timestamp dell'audio,
   start/edit/video prompt, foto LEGO di partenza. Segue la skill `director` del plugin (hero frame
   più catena di Qwen Edit, end frame della scena N = start frame della scena N+1, stato su disco).
3. **lego-prompt-engineer**: scrive e rifinisce i prompt per lo stile "real LEGO brickfilm":
   mattoncini in plastica ABS con riflessi e stud visibili, minifigure, profondità di campo da
   macro, animazione stop-motion a scatti. Mantiene i negative prompt contro deformazioni dei
   pezzi, mani umane e testo. Ha anche il ruolo di revisore della qualità dei prompt degli altri agenti.
4. **comfyui-video-specialist**: costruisce ed esegue i workflow video tramite i tool `pixelforge`
   e le skill del plugin (`wan-flf-video`, `ltxv2-video`, `qwen-image-edit`, `video-extend`,
   `video-upscale`, `z-image-txt2img`). È responsabile della **transizione foto reale → animazione
   LEGO**: la foto reale è il first frame, un end frame stilizzato si ottiene con Qwen Edit dalla
   stessa foto, e WAN FLF interpola tra i due. Gestisce `clear_vram` tra famiglie di modelli e
   verifica ogni output guardandolo (vedi le regole CRITICAL della skill `director`). Valuta
   `train-character-lora` solo se la consistenza dei personaggi non regge, e solo dopo avermelo chiesto.
5. **audio-sync-editor**: prepara l'audio (normalizzazione e pulizia leggera con ffmpeg, senza
   alterare la voce), produce una trascrizione con timestamp in locale, calcola le durate delle
   scene, monta le clip con ffmpeg (concat, crossfade, eventuale rallentamento o frame
   interpolation per arrivare alla durata giusta) e fa il mux con la voce. Output in `renders/`.

L'`orchestrator` instrada le richieste verso questi domini. Regola per il tier: sonnet per i
compiti meccanici e ben definiti, opus per le decisioni creative/di design e per il debug di
workflow che non funzionano. Mai dispatch a un nome di dominio senza tier.

## Fase 4: CLAUDE.md del progetto
Scrivi un `CLAUDE.md` (in inglese) che fissi:
- lo scopo del progetto e la pipeline: foto → catalogo → storia + audio → scene plan →
  frame (hero + Qwen Edit chain) → clip WAN FLF / LTX → montaggio sincronizzato alla voce;
- le **decisioni bloccate**:
  - ogni filmato si apre sulla foto reale e sfuma nell'animazione LEGO;
  - la voce di mio figlio comanda il timing: si adattano le clip all'audio, mai il contrario
    (niente time-stretch della voce);
  - `lego-photos/` e `audio/raw/` sono di sola lettura;
  - niente upload esterni di foto o audio;
  - nessuna modifica al repo PixelForge da questo progetto: bug o feature mancanti si annotano
    e me li segnali, li sistemo io nel repo del plugin;
- che il progetto dipende dal plugin `pixelforge@pixelforge-mcp` e da quali skill usa;
- la mappa degli agenti e quando usarli;
- la regola "verifica ogni output prima di andare avanti" della skill `director`;
- lingua: codice, prompt e agenti in inglese; con me si parla italiano.

## Fase 5: chiusura
Alla fine:
- mostrami l'albero dei file creati e il contenuto di `.claude/settings.json`;
- dimmi esattamente cosa devo fare io (riavvio, `/mcp`, `/add-dir`, dove mettere le foto e gli audio);
- elenca i modelli necessari (WAN 2.2 FLF high/low, Qwen Image Edit, Z-Image, eventualmente LTX-2)
  confrontandoli con quelli già presenti in ComfyUI, e indica quali mancano. Non scaricarli
  senza il mio OK;
- proponi un piccolo **test di fumo** da fare quando avrò caricato la prima foto: un'unica clip
  da circa 5 secondi, foto reale → versione animata LEGO, senza audio. Non eseguirlo finché non te lo dico.

Fai domande se qualcosa è ambiguo, invece di inventare.
````
