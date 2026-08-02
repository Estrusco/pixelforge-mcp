import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeColor, computeAlphaStats } from "../../services/color-analysis.js";

const scratchRoot = mkdtempSync(join(tmpdir(), "pixelforge-color-analysis-"));

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function writePng(name: string, buffer: Buffer): Promise<string> {
  const path = join(scratchRoot, name);
  await sharp(buffer).toFile(path);
  return path;
}

function bodyOf(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content.find((c) => c.type === "text") as { text: string };
  const jsonStart = text.text.indexOf("{");
  return JSON.parse(text.text.slice(jsonStart));
}

describe("analyzeColor — alpha stats", () => {
  it("reports alpha stats for an RGBA source with mixed transparency", async () => {
    // 4x4, built pixel-by-pixel (sharp's composite blend modes recompute the
    // WHOLE canvas via the source's own bounds, not just the placed region,
    // so a smaller-than-canvas transparent patch can't be composited in
    // reliably — a raw buffer is the direct, unambiguous way to get this).
    // Top-left 2x2 (4 of 16 px) fully transparent, rest fully opaque green.
    const raw = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        const transparent = x < 2 && y < 2;
        raw[i] = 0;
        raw[i + 1] = 255;
        raw[i + 2] = 0;
        raw[i + 3] = transparent ? 0 : 255;
      }
    }
    const png = await sharp(raw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
    const path = await writePng("mixed-alpha.png", png);

    const result = await analyzeColor({ path });
    const body = bodyOf(result);
    const alpha = body.alpha as { transparentPct: number; opaquePct: number; semiTransparentPct: number };

    expect(alpha).toBeDefined();
    expect(alpha.transparentPct).toBe(25); // 4 of 16 px
    expect(alpha.opaquePct).toBe(75);
    expect(alpha.semiTransparentPct).toBe(0);
  });

  it("omits alpha entirely for a source with no alpha channel (e.g. flattened/opaque)", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const path = await writePng("opaque.jpg", png);

    const result = await analyzeColor({ path });
    const body = bodyOf(result);
    expect(body.alpha).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"alpha"');
  });

  it("does not change the RGB-derived stats when alpha is present (regression guard)", async () => {
    const pngNoAlpha = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    const pngWithAlpha = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 255 } },
    })
      .png()
      .toBuffer();

    const noAlphaResult = bodyOf(await analyzeColor({ path: await writePng("no-alpha.png", pngNoAlpha) }));
    const withAlphaResult = bodyOf(
      await analyzeColor({ path: await writePng("with-alpha.png", pngWithAlpha) }),
    );

    expect(withAlphaResult.channels).toEqual(noAlphaResult.channels);
    expect(withAlphaResult.luma).toEqual(noAlphaResult.luma);
  });

  it("reports fully-opaque alpha stats for a plain RGBA PNG (no transparency)", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 255 } },
    })
      .png()
      .toBuffer();
    const path = await writePng("fully-opaque.png", png);

    const result = await analyzeColor({ path });
    const body = bodyOf(result);
    const alpha = body.alpha as { transparentPct: number; opaquePct: number; meanAlpha: number };
    expect(alpha.opaquePct).toBe(100);
    expect(alpha.transparentPct).toBe(0);
    expect(alpha.meanAlpha).toBe(255);
  });
});

describe("computeAlphaStats", () => {
  it("returns undefined for a 3-channel (no alpha) raw buffer", () => {
    const data = Buffer.alloc(4 * 3, 128);
    expect(computeAlphaStats({ data, width: 2, height: 2, channels: 3 })).toBeUndefined();
  });

  it("buckets semi-transparent pixels separately from fully transparent/opaque", () => {
    // 4 pixels, RGBA: alpha = 0, 128, 255, 255
    const data = Buffer.from([
      0, 0, 0, 0,
      0, 0, 0, 128,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    const stats = computeAlphaStats({ data, width: 2, height: 2, channels: 4 });
    expect(stats).toEqual({
      transparentPct: 25,
      semiTransparentPct: 25,
      opaquePct: 50,
      meanAlpha: (0 + 128 + 255 + 255) / 4,
    });
  });
});
