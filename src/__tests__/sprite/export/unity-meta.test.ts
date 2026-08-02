import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUnityTextureMeta,
  generateUnityGuid,
  isInsideUnityProject,
  pathExists,
} from "../../../sprite/export/unity-meta.js";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelforge-unity-meta-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("generateUnityGuid", () => {
  it("returns a 32-char lowercase hex string with no dashes", () => {
    const guid = generateUnityGuid();
    expect(guid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a different value on each call", () => {
    expect(generateUnityGuid()).not.toBe(generateUnityGuid());
  });
});

describe("buildUnityTextureMeta", () => {
  it("includes the given guid and pixels-per-unit", () => {
    const meta = buildUnityTextureMeta({ guid: "abc123", pixelsPerUnit: 32 });
    expect(meta).toContain("guid: abc123");
    expect(meta).toContain("spritePixelsToUnits: 32");
  });

  it("sets Sprite type, Single mode, Point filtering, and no compression", () => {
    const meta = buildUnityTextureMeta({ guid: "x", pixelsPerUnit: 16 });
    expect(meta).toMatch(/textureType:\s*8/); // Sprite
    expect(meta).toMatch(/spriteMode:\s*1/); // Single
    expect(meta).toMatch(/filterMode:\s*0/); // Point
    expect(meta).toContain("textureCompression: 0"); // None (per-platform override)
  });

  it("starts with the standard .meta file header", () => {
    const meta = buildUnityTextureMeta({ guid: "x", pixelsPerUnit: 100 });
    expect(meta.startsWith("fileFormatVersion: 2\nguid: x\n")).toBe(true);
  });
});

describe("pathExists", () => {
  it("is true for an existing file", async () => {
    const dir = await scratch();
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    expect(await pathExists(file)).toBe(true);
  });

  it("is false for a missing path", async () => {
    const dir = await scratch();
    expect(await pathExists(join(dir, "missing.txt"))).toBe(false);
  });
});

describe("isInsideUnityProject", () => {
  it("detects a PNG under Assets/ with a sibling ProjectSettings/", async () => {
    const root = await scratch();
    await mkdir(join(root, "Assets", "Sprites"), { recursive: true });
    await mkdir(join(root, "ProjectSettings"), { recursive: true });

    const png = join(root, "Assets", "Sprites", "hero.png");
    expect(await isInsideUnityProject(png)).toBe(true);
  });

  it("detects a PNG several levels deep under Assets/", async () => {
    const root = await scratch();
    await mkdir(join(root, "Assets", "Art", "Characters", "Hero"), { recursive: true });
    await mkdir(join(root, "ProjectSettings"), { recursive: true });

    const png = join(root, "Assets", "Art", "Characters", "Hero", "hero.png");
    expect(await isInsideUnityProject(png)).toBe(true);
  });

  it("returns false when there is an Assets/ folder but NO ProjectSettings/ sibling", async () => {
    const root = await scratch();
    await mkdir(join(root, "Assets", "Sprites"), { recursive: true });
    // No ProjectSettings/ created.

    const png = join(root, "Assets", "Sprites", "hero.png");
    expect(await isInsideUnityProject(png)).toBe(false);
  });

  it("returns false for a plain directory with no Assets/ ancestor at all", async () => {
    const root = await scratch();
    await mkdir(join(root, "output", "sprites"), { recursive: true });

    const png = join(root, "output", "sprites", "hero.png");
    expect(await isInsideUnityProject(png)).toBe(false);
  });

  it("never throws for a nonexistent path", async () => {
    await expect(isInsideUnityProject("Z:/definitely/not/a/real/path/hero.png")).resolves.toBe(false);
  });
});
