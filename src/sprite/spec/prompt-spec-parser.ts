import { ValidationError } from "../../utils/errors.js";
import type { PromptSpec, SpecImageScaleStep, SpecLora, SpecPostProcess } from "./prompt-spec-types.js";

// ---------------------------------------------------------------------------
// Parser for the bracketed-section plain-text prompt-spec format — PURE. No
// disk, no network. See prompt-spec-types.ts for the shape this produces.
//
// The format (see PixelForgeDocumentations fixtures / promptesempio.txt):
//
//   [SECTION NAME]
//   Key: value
//   Key2: value2 (o alternate value)
//
//   --------------------------------------------------------------------
//   [POSITIVE PROMPT]
//   --------------------------------------------------------------------
//   free-form prompt text, possibly wrapped across lines
//
// `---`/`===` divider lines are decorative and ignored wherever they appear.
// Section names are matched case-insensitively and normalized (whitespace
// collapsed) so "[CHECKPOINT / MODEL]" and "[Checkpoint/Model]" are the same
// section. `[LORA]` is the one section that may repeat: each occurrence in
// the document becomes one entry in `PromptSpec.loras`.
// ---------------------------------------------------------------------------

const DIVIDER_RE = /^[-=]{3,}\s*$/;
const SECTION_RE = /^\[([^\]]+)\]$/;
const KEY_VALUE_RE = /^([^:]+):\s*(.*)$/;

/** Collapse internal whitespace and case for section-name / key matching. */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

interface Section {
  readonly name: string;
  readonly lines: string[];
}

/** Split raw text into bracketed sections, dropping divider lines and any
 *  content before the first `[SECTION]` header (e.g. a decorative title banner). */
function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || DIVIDER_RE.test(line)) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      current = { name: normalize(sectionMatch[1]), lines: [] };
      sections.push(current);
      continue;
    }

    current?.lines.push(rawLine.trim());
  }

  return sections;
}

function findSection(sections: readonly Section[], name: string): Section | undefined {
  return sections.find((s) => s.name === name);
}

/** Like `findSection`, but returns every match in document order — used for
 *  `[LORA]`, the one section that may repeat. */
function findAllSections(sections: readonly Section[], name: string): Section[] {
  return sections.filter((s) => s.name === name);
}

/** Parse a section's lines as `Key: value` pairs into a normalized-key map. */
function parseKeyValues(section: Section): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of section.lines) {
    const match = KEY_VALUE_RE.exec(line);
    if (!match) continue;
    map.set(normalize(match[1]), match[2].trim());
  }
  return map;
}

/** "name.safetensors (o alt.safetensors, altro.safetensors)" -> ["name.safetensors", "alt.safetensors", "altro.safetensors"]. */
function splitAlternates(value: string): string[] {
  const parenMatch = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(value);
  if (!parenMatch) return [value.trim()];

  const primary = parenMatch[1].trim();
  const inside = parenMatch[2]
    // Drop a leading "o "/"or " (the Italian/English "or" connective).
    .replace(/^\s*(o|or)\s+/i, "")
    .split(/,|\s+(?:o|or)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return [primary, ...inside];
}

/** "1024x1024 (Base SDXL)" -> "1024x1024"; "dpmpp_2m_sde (o euler_ancestral)" -> "dpmpp_2m_sde". */
function stripParenthetical(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function parseResolution(value: string, sourceLabel: string): { width: number; height: number } {
  const primary = stripParenthetical(value);
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(primary);
  if (!match) {
    throw new ValidationError(
      `${sourceLabel}: could not parse resolution "${value}" — expected "<width>x<height>", e.g. "1024x1024".`,
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseNumber(value: string, fieldLabel: string): number {
  const n = Number(stripParenthetical(value));
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${fieldLabel}: "${value}" is not a valid number.`);
  }
  return n;
}

/** "Downscale Node: ImageScale (Width: 128, Height: 128, Upscale Method: nearest-exact)" -> { width: 128, height: 128, method: "nearest-exact" }. */
function parseImageScaleStep(value: string, fieldLabel: string): SpecImageScaleStep {
  const width = /width:\s*(\d+)/i.exec(value);
  const height = /height:\s*(\d+)/i.exec(value);
  const method = /(?:upscale method|method):\s*([a-z0-9_-]+)/i.exec(value);
  if (!width || !height || !method) {
    throw new ValidationError(
      `${fieldLabel}: could not parse "${value}" — expected a form like ` +
        `"ImageScale (Width: 128, Height: 128, Upscale Method: nearest-exact)".`,
    );
  }
  return { width: Number(width[1]), height: Number(height[1]), method: method[1] };
}

function parsePositiveOrNegativePrompt(sections: readonly Section[], name: string): string | undefined {
  const section = findSection(sections, name);
  if (!section || section.lines.length === 0) return undefined;
  return section.lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Parse every `[LORA]` block in document order; a block with no `LoRA Name:`
 *  is skipped rather than throwing (mirrors the previous single-LoRA behavior). */
function parseLoras(sections: readonly Section[]): SpecLora[] {
  const loras: SpecLora[] = [];

  for (const section of findAllSections(sections, "lora")) {
    const kv = parseKeyValues(section);
    const name = kv.get("lora name");
    if (!name) continue;

    const strengthModel = kv.has("lora model weight") ? parseNumber(kv.get("lora model weight")!, "LoRA Model Weight") : 1.0;
    const strengthClip = kv.has("lora clip weight") ? parseNumber(kv.get("lora clip weight")!, "LoRA CLIP Weight") : strengthModel;
    const triggerWords = (kv.get("trigger words") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    loras.push({ name, strengthModel, strengthClip, triggerWords });
  }

  return loras;
}

function parsePostProcess(sections: readonly Section[]): SpecPostProcess | undefined {
  const section = findSection(sections, "post-processing / pixel perfect grid") ?? findSection(sections, "post-processing");
  if (!section) return undefined;
  const kv = parseKeyValues(section);
  const downscaleRaw = kv.get("downscale node");
  const upscaleRaw = kv.get("upscale node");
  if (!downscaleRaw && !upscaleRaw) return undefined;
  if (!downscaleRaw || !upscaleRaw) {
    throw new ValidationError(
      "[POST-PROCESSING / PIXEL PERFECT GRID]: both \"Downscale Node\" and \"Upscale Node\" are " +
        "required when this section is present.",
    );
  }
  return {
    downscale: parseImageScaleStep(downscaleRaw, "Downscale Node"),
    upscale: parseImageScaleStep(upscaleRaw, "Upscale Node"),
  };
}

/**
 * Parse a prompt-spec text file into a `PromptSpec`. Throws `ValidationError`
 * with an actionable message when a required field is missing or malformed.
 * `[LORA]` (repeatable, zero or more), `VAE:`, and
 * `[POST-PROCESSING / PIXEL PERFECT GRID]` are optional; everything else is
 * required.
 */
export function parsePromptSpec(text: string): PromptSpec {
  const sections = splitSections(text);

  const checkpointSection = findSection(sections, "checkpoint / model") ?? findSection(sections, "checkpoint");
  const samplerSection =
    findSection(sections, "sampler & scheduler settings") ?? findSection(sections, "sampler / scheduler settings");

  if (!checkpointSection) {
    throw new ValidationError('Prompt spec is missing a "[CHECKPOINT / MODEL]" section.');
  }
  if (!samplerSection) {
    throw new ValidationError('Prompt spec is missing a "[SAMPLER & SCHEDULER SETTINGS]" section.');
  }

  const checkpointKv = parseKeyValues(checkpointSection);
  const samplerKv = parseKeyValues(samplerSection);

  const checkpointValue = checkpointKv.get("checkpoint");
  if (!checkpointValue) {
    throw new ValidationError('"[CHECKPOINT / MODEL]" section is missing a "Checkpoint:" line.');
  }
  const checkpointCandidates = splitAlternates(checkpointValue);

  const vae = checkpointKv.get("vae")?.trim() || undefined;

  const samplerValue = samplerKv.get("sampler");
  const schedulerValue = samplerKv.get("scheduler");
  const stepsValue = samplerKv.get("steps");
  const cfgValue = samplerKv.get("cfg scale") ?? samplerKv.get("cfg");
  const resolutionValue = samplerKv.get("resolution");

  const missing: string[] = [];
  if (!samplerValue) missing.push("Sampler");
  if (!schedulerValue) missing.push("Scheduler");
  if (!stepsValue) missing.push("Steps");
  if (!cfgValue) missing.push("CFG Scale");
  if (!resolutionValue) missing.push("Resolution");
  if (missing.length > 0) {
    throw new ValidationError(
      `"[SAMPLER & SCHEDULER SETTINGS]" section is missing: ${missing.join(", ")}.`,
    );
  }

  const { width, height } = parseResolution(resolutionValue!, "Resolution");

  const positivePrompt = parsePositiveOrNegativePrompt(sections, "positive prompt");
  const negativePrompt = parsePositiveOrNegativePrompt(sections, "negative prompt");
  if (!positivePrompt) {
    throw new ValidationError('Prompt spec is missing a "[POSITIVE PROMPT]" section with content.');
  }

  return {
    checkpointCandidates,
    vae,
    loras: parseLoras(sections),
    sampler: stripParenthetical(samplerValue!),
    scheduler: stripParenthetical(schedulerValue!),
    steps: parseNumber(stepsValue!, "Steps"),
    cfg: parseNumber(cfgValue!, "CFG Scale"),
    width,
    height,
    positivePrompt,
    negativePrompt: negativePrompt ?? "",
    postProcess: parsePostProcess(sections),
  };
}
