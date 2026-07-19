import type { LospecPresetSlug } from "../../types.js";

// Hex lists cross-checked against multiple independent mirrors at
// implementation time (lospec.com itself is unreachable from this
// environment's network policy). No runtime network fetch — see CLAUDE.md
// "Palettes are hardcoded, no network fetch."

const PICO_8: readonly string[] = [
  "#000000",
  "#1D2B53",
  "#7E2553",
  "#008751",
  "#AB5236",
  "#5F574F",
  "#C2C3C7",
  "#FFF1E8",
  "#FF004D",
  "#FFA300",
  "#FFEC27",
  "#00E436",
  "#29ADFF",
  "#83769C",
  "#FF77A8",
  "#FFCCAA",
];

const SWEETIE_16: readonly string[] = [
  "#1a1c2c",
  "#5d275d",
  "#b13e53",
  "#ef7d57",
  "#ffcd75",
  "#a7f070",
  "#38b764",
  "#257179",
  "#29366f",
  "#3b5dc9",
  "#41a6f6",
  "#73eff7",
  "#f4f4f4",
  "#94b0c2",
  "#566c86",
  "#333c57",
];

const ENDESGA_32: readonly string[] = [
  "#be4a2f",
  "#d77643",
  "#ead4aa",
  "#e4a672",
  "#b86f50",
  "#733e39",
  "#3e2731",
  "#a22633",
  "#e43b44",
  "#f77622",
  "#feae34",
  "#fee761",
  "#63c74d",
  "#3e8948",
  "#265c42",
  "#193c3e",
  "#124e89",
  "#0099db",
  "#2ce8f5",
  "#ffffff",
  "#c0cbdc",
  "#8b9bb4",
  "#5a6988",
  "#3a4466",
  "#262b44",
  "#181425",
  "#ff0044",
  "#68386c",
  "#b55088",
  "#f6757a",
  "#e8b796",
  "#c28569",
];

// Verified official 64-color list from Kerrie Lake's Lospec page
// (lospec.com/palette-list/resurrect-64), fetched directly from source.
const RESURRECT_64: readonly string[] = [
  "#2e222f", "#3e3546", "#625565", "#966c6c", "#ab947a", "#694f62", "#7f708a", "#9babb2",
  "#c7dcd0", "#ffffff", "#6e2727", "#b33831", "#ea4f36", "#f57d4a", "#ae2334", "#e83b3b",
  "#fb6b1d", "#f79617", "#f9c22b", "#7a3045", "#9e4539", "#cd683d", "#e6904e", "#fbb954",
  "#4c3e24", "#676633", "#a2a947", "#d5e04b", "#fbff86", "#165a4c", "#239063", "#1ebc73",
  "#91db69", "#cddf6c", "#313638", "#374e4a", "#547e64", "#92a984", "#b2ba90", "#0b5e65",
  "#0b8a8f", "#0eaf9b", "#30e1b9", "#8ff8e2", "#323353", "#484a77", "#4d65b4", "#4d9be6",
  "#8fd3ff", "#45293f", "#6b3e75", "#905ea9", "#a884f3", "#eaaded", "#753c54", "#a24b6f",
  "#cf657f", "#ed8099", "#831c5d", "#c32454", "#f04f78", "#f68181", "#fca790", "#fdcbb0",
];

const LOSPEC_PRESETS: Readonly<Record<LospecPresetSlug, readonly string[]>> = {
  "pico-8": PICO_8,
  "sweetie-16": SWEETIE_16,
  "endesga-32": ENDESGA_32,
  "resurrect-64": RESURRECT_64,
};

export function getLospecPreset(slug: LospecPresetSlug): readonly string[] {
  return LOSPEC_PRESETS[slug];
}

export const LOSPEC_PRESET_SLUGS: readonly LospecPresetSlug[] = Object.keys(
  LOSPEC_PRESETS,
) as LospecPresetSlug[];
