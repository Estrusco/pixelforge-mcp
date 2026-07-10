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

const LOSPEC_PRESETS: Readonly<Record<LospecPresetSlug, readonly string[]>> = {
  "pico-8": PICO_8,
  "sweetie-16": SWEETIE_16,
  "endesga-32": ENDESGA_32,
};

export function getLospecPreset(slug: LospecPresetSlug): readonly string[] {
  return LOSPEC_PRESETS[slug];
}
