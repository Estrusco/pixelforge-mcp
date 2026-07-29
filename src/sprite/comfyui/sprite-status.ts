import { AssetRegistry } from "../../services/asset-registry.js";
import type { AssetRecord } from "../../services/asset-registry.js";
import { getJobStatus } from "../../services/queue-manager.js";
import type { SpriteResultAsset, SpriteResultStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Sprite job status + asset resolution — the ONE legitimate polling loop for
// sprite jobs in this layer.
//
// `resolveSpriteJobStatus` is a single non-blocking status read: query the
// inherited `getJobStatus` (src/services/queue-manager.ts), and once done with
// no error, resolve the produced image asset(s) via `AssetRegistry.list()`
// filtered by `promptId` (there is no `AssetRegistry.getByPromptId()`, so
// list()+filter is the established pattern — see src/tools/assets.ts's
// list_assets/view_image). This is exactly what get_sprite_result exposes.
//
// `waitForSpriteJob` builds on it: poll until done or a timeout elapses,
// modeled on the existing `wait: true` pattern in
// `src/tools/run-template.ts` (1.5s poll interval, `timeout_s` default 300,
// "still running after timeout" left running rather than cancelled). Intended
// for callers that need to block on one job before starting the next — e.g.
// generate_animation_set waiting for frame N before staging its output as
// frame N+1's img2img reference.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_S = 300;
const POLL_INTERVAL_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function summarizeAsset(record: AssetRecord): SpriteResultAsset {
  return {
    assetId: record.assetId,
    filename: record.filename,
    subfolder: record.subfolder,
  };
}

/**
 * Single non-blocking status read for one sprite job. While the job is still
 * running/pending, `assets` is `undefined`. Once `done` with no `error`,
 * `assets` is the sprite image(s) resolved from `AssetRegistry.list()`
 * filtered by `promptId` (see `SpriteResultStatus` in `../types.js`).
 */
export async function resolveSpriteJobStatus(promptId: string): Promise<SpriteResultStatus> {
  const status = await getJobStatus(promptId);

  const assets: SpriteResultAsset[] | undefined =
    status.done && !status.error
      ? AssetRegistry.list()
          .filter((record) => record.promptId === promptId)
          .map(summarizeAsset)
      : undefined;

  return {
    promptId,
    running: status.running,
    pending: status.pending,
    done: status.done,
    statusStr: status.status_str,
    error: status.error,
    executionStats: status.execution_stats,
    assets,
  };
}

export interface WaitForSpriteJobOptions {
  /** Max seconds to wait before giving up. Default 300, matching run_template's wait:true. */
  readonly timeoutS?: number;
  /** Poll interval in ms. Default 1500, matching run_template's wait:true. */
  readonly pollIntervalMs?: number;
}

/**
 * Status of a sprite job once `waitForSpriteJob` returns, plus whether it
 * returned because of a timeout rather than completion. On timeout the job
 * keeps running server-side (it is NOT cancelled) and this reflects the last
 * status read before giving up — callers should poll `resolveSpriteJobStatus`
 * again later if they still need the result.
 */
export interface SpriteJobWaitResult extends SpriteResultStatus {
  readonly timedOut: boolean;
}

/**
 * Poll `resolveSpriteJobStatus` until the job is done or `timeoutS` elapses.
 * The sprite layer's one legitimate polling loop — do not hand-roll a second
 * copy of list()+filter-by-promptId elsewhere.
 */
export async function waitForSpriteJob(
  promptId: string,
  options: WaitForSpriteJobOptions = {},
): Promise<SpriteJobWaitResult> {
  const timeoutMs = (options.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const start = Date.now();

  for (;;) {
    const status = await resolveSpriteJobStatus(promptId);
    if (status.done) {
      return { ...status, timedOut: false };
    }
    if (Date.now() - start >= timeoutMs) {
      return { ...status, timedOut: true };
    }
    await sleep(pollIntervalMs);
  }
}
