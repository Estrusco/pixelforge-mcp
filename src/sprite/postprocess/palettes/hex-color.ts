const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function hexToRgb(hex: string): readonly [number, number, number] {
  const match = HEX_RE.exec(hex.trim());
  if (!match) {
    throw new Error(`Invalid hex color "${hex}". Expected a 6-digit hex, e.g. "#1a1c2c".`);
  }
  const value = match[1];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHexByte = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}
