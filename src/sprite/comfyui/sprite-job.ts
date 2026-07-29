import type { WorkflowJSON } from "../../comfyui/types.js";
import { enqueueWorkflow } from "../../services/workflow-executor.js";
import type { EnqueueWorkflowOptions } from "../../services/workflow-executor.js";
import type { Style } from "../types.js";
import type { SpriteJobRequest, SpriteJobResult } from "../types.js";
import { resolveSpriteCheckpoint } from "./checkpoint-resolver.js";
import { buildSpriteWorkflow } from "./sprite-workflow.js";

// ---------------------------------------------------------------------------
// Job bridge — a thin wrapper over the INHERITED queue machinery. It resolves a
// checkpoint, builds the graph, and hands it to enqueueWorkflow. It must never
// grow its own queueing, polling, WebSocket, or VRAM logic (CLAUDE.md).
// ---------------------------------------------------------------------------

/** Internal injection seam. Callers pass a request and nothing else. */
export interface SpriteJobDeps {
  readonly resolveCheckpoint: (style: Style, override?: string) => Promise<string>;
  readonly enqueue: (
    workflow: WorkflowJSON,
    options: EnqueueWorkflowOptions,
  ) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

const DEFAULT_DEPS: SpriteJobDeps = {
  resolveCheckpoint: (style, override) => resolveSpriteCheckpoint(style, override),
  enqueue: (workflow, options) => enqueueWorkflow(workflow, options),
};

/**
 * Build and enqueue one sprite generation job. Fire-and-forget: resolves as soon
 * as ComfyUI accepts the prompt.
 *
 * `disable_random_seed: true` is REQUIRED. enqueueWorkflow otherwise rewrites
 * every `seed` / `noise_seed` input with a fresh random value, which would make
 * the seed reported back to the caller a lie and break both reproduction and
 * generate_animation_set's frame-to-frame consistency.
 */
export async function enqueueSpriteJob(
  request: SpriteJobRequest,
  deps: SpriteJobDeps = DEFAULT_DEPS,
): Promise<SpriteJobResult> {
  const checkpoint = await deps.resolveCheckpoint(request.style, request.checkpoint);
  const { workflow, mode } = buildSpriteWorkflow(request, checkpoint);
  const { prompt_id, queue_remaining } = await deps.enqueue(workflow, {
    disable_random_seed: true,
  });

  return {
    promptId: prompt_id,
    queueRemaining: queue_remaining,
    checkpoint,
    seed: request.seed,
    mode,
  };
}
