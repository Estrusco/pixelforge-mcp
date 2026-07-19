// Shared interfaces for PixelForge sprite tooling. Tool I/O contracts (Style,
// Viewpoint, MotionState, etc.) land here as each tool is implemented; for now
// this covers the pixelate_image postprocess pipeline only.

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

// Alpha-preserving RGBA pixel buffer: 4 bytes/pixel, row-major, uint8 per channel.
export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

// Palettes verified against a reachable source at implementation time.
export type LospecPresetSlug = "pico-8" | "sweetie-16" | "endesga-32" | "resurrect-64";

export type PaletteSource =
  | { readonly mode: "auto_kmeans"; readonly paletteSize: number }
  | { readonly mode: "lospec"; readonly slug: LospecPresetSlug }
  | { readonly mode: "custom"; readonly colors: readonly string[] };

export interface QuantizeOptions {
  readonly targetResolution: Dimensions;
  readonly palette: PaletteSource;
  // Default true. 4-neighbor despeckle pass after nearest-color mapping.
  readonly cleanupIsolatedPixels?: boolean;
}

export interface QuantizeResult {
  readonly png: Buffer;
  // Resolved hex colors actually used for the nearest-color mapping.
  readonly palette: readonly string[];
  readonly width: number;
  readonly height: number;
}
