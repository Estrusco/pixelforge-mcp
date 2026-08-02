import { createHash } from "node:crypto";
import type { WorkflowJSON } from "../comfyui/types.js";

export interface AssetImage {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
}

export interface AssetOutput {
  node_id: string;
  images: AssetImage[];
}

export interface AssetRecord {
  assetId: string;
  promptId: string;
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  workflow: WorkflowJSON;
  createdAt: number;
}

export interface RegisterArgs {
  promptId: string;
  workflow: WorkflowJSON;
  outputs: AssetOutput[];
}

export interface RegisterLocalArgs {
  filename: string;
  subfolder?: string;
  /** ComfyUI directory the file was uploaded/written to. Default "input". */
  type?: string;
}

/** Prefix marking a promptId as synthetic (no real ComfyUI job behind it). */
const LOCAL_PROMPT_PREFIX = "local:";

export interface ListArgs {
  limit?: number;
  since?: number;
}

interface RegistryConfig {
  ttlMs: number;
  now: () => number;
}

const DEFAULT_TTL_MS =
  (() => {
    const raw = process.env.COMFYUI_ASSET_TTL_HOURS;
    const hours = raw ? Number(raw) : 24;
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  })();

const state = {
  records: new Map<string, AssetRecord>(),
  config: { ttlMs: DEFAULT_TTL_MS, now: Date.now } as RegistryConfig,
};

function makeAssetId(promptId: string, img: AssetImage): string {
  const hash = createHash("sha256")
    .update(`${promptId}\0${img.filename}\0${img.subfolder}\0${img.type}`)
    .digest("hex");
  return `a_${hash.slice(0, 8)}`;
}

function deepCloneWorkflow(wf: WorkflowJSON): WorkflowJSON {
  return JSON.parse(JSON.stringify(wf)) as WorkflowJSON;
}

function isExpired(record: AssetRecord): boolean {
  return state.config.now() - record.createdAt >= state.config.ttlMs;
}

export const AssetRegistry = {
  /**
   * Register all images produced by a completed prompt.
   * Returns the AssetRecords created (one per image).
   */
  register({ promptId, workflow, outputs }: RegisterArgs): AssetRecord[] {
    const snapshot = deepCloneWorkflow(workflow);
    const created: AssetRecord[] = [];
    for (const output of outputs) {
      for (const img of output.images) {
        const assetId = makeAssetId(promptId, img);
        const record: AssetRecord = {
          assetId,
          promptId,
          nodeId: output.node_id,
          filename: img.filename,
          subfolder: img.subfolder,
          type: img.type,
          url: img.url,
          workflow: snapshot,
          createdAt: state.config.now(),
        };
        state.records.set(assetId, record);
        created.push(record);
      }
    }
    return created;
  },

  /**
   * Register a locally produced image (e.g. pixelate_image output) that has
   * no real ComfyUI job behind it. Uses a synthetic `local:<hash>` promptId
   * and an empty workflow snapshot, so `regenerate` can detect and reject it
   * (see isLocalAsset()) instead of enqueueing an empty prompt.
   */
  registerLocal({ filename, subfolder = "", type = "input" }: RegisterLocalArgs): AssetRecord {
    const now = state.config.now();
    const promptId = `${LOCAL_PROMPT_PREFIX}${createHash("sha256")
      .update(`${filename}\0${subfolder}\0${type}\0${now}\0${Math.random()}`)
      .digest("hex")
      .slice(0, 16)}`;
    const assetId = makeAssetId(promptId, { filename, subfolder, type, url: "" });
    const record: AssetRecord = {
      assetId,
      promptId,
      nodeId: "local",
      filename,
      subfolder,
      type,
      url: "",
      workflow: {},
      createdAt: now,
    };
    state.records.set(assetId, record);
    return record;
  },

  /** Look up a record by id. Returns undefined for missing or expired. */
  get(assetId: string): AssetRecord | undefined {
    const record = state.records.get(assetId);
    if (!record) return undefined;
    if (isExpired(record)) {
      state.records.delete(assetId);
      return undefined;
    }
    return record;
  },

  /** List records newest-first. */
  list({ limit, since }: ListArgs = {}): AssetRecord[] {
    const all = [...state.records.values()].filter((r) => !isExpired(r));
    const filtered = since !== undefined ? all.filter((r) => r.createdAt >= since) : all;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  },

  /** Remove expired records. Returns number pruned. */
  prune(): number {
    let count = 0;
    for (const [id, record] of state.records) {
      if (isExpired(record)) {
        state.records.delete(id);
        count++;
      }
    }
    return count;
  },

  /** Test/diagnostic helper — wipe all records. */
  clear(): void {
    state.records.clear();
  },

  /** Test/diagnostic helper — override ttl and clock. */
  configure(opts: Partial<RegistryConfig>): void {
    if (opts.ttlMs !== undefined) state.config.ttlMs = opts.ttlMs;
    if (opts.now !== undefined) state.config.now = opts.now;
  },

  /** Inspect current size (debug only). */
  size(): number {
    return state.records.size;
  },
};

/** True for assets registered via `AssetRegistry.registerLocal()` — no real workflow to re-enqueue. */
export function isLocalAsset(record: AssetRecord): boolean {
  return record.promptId.startsWith(LOCAL_PROMPT_PREFIX);
}

/**
 * Apply a flat override map to every node input in a workflow.
 * For each (key, value) in overrides, sets node.inputs[key] = value on any node
 * that already has that input. Returns a new workflow; does not mutate input.
 *
 * Example: { cfg: 8, seed: 12345 } → updates KSampler-style nodes only.
 */
export function applyOverrides(
  workflow: WorkflowJSON,
  overrides: Record<string, unknown> | undefined,
): WorkflowJSON {
  const next = deepCloneWorkflow(workflow);
  if (!overrides) return next;
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    for (const [key, value] of Object.entries(overrides)) {
      if (key in node.inputs) {
        node.inputs[key] = value;
      }
    }
  }
  return next;
}
