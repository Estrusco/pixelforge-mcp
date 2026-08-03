import {
  composeMotionFramePrompt,
  enqueueSpriteJob,
  resolveSpriteCheckpoint,
  waitForSpriteJob,
} from "./comfyui/index.js";
import type { ResolvedCheckpoint, SpriteJobWaitResult } from "./comfyui/index.js";
import { resolveReferenceImage } from "./reference-image.js";
import type { StagedReference } from "./reference-image.js";
import type {
  AnimationFrameResult,
  AnimationSetOutcome,
  AnimationSetRequest,
  AnimationSetResult,
  AnimationStateResult,
  DownloadedModelInfo,
  MotionState,
  SpriteGenerationMode,
  SpriteJobRequest,
  SpriteJobResult,
  Style,
} from "./types.js";

// ---------------------------------------------------------------------------
// generate_animation_set execution engine — the `img2img_low_denoise`
// consistency story, and nothing else.
//
// Lives at `src/sprite/` (next to reference-image.ts) rather than under
// `src/sprite/comfyui/` because it is ORCHESTRATION over the comfyui bridge —
// enqueue, wait, stage, repeat — not workflow-JSON construction. It owns no
// queue, no WebSocket, and no polling of its own: enqueue goes through
// `enqueueSpriteJob`, waiting through `waitForSpriteJob` (the sprite layer's
// one legitimate poll loop), staging through `resolveReferenceImage`.
//
// Three properties are load-bearing and must not be "optimized" away:
//
//   1. STRICTLY SEQUENTIAL. One job in flight at a time, across every state and
//      every frame. Fanning frames out in parallel would hammer the inherited
//      queue and the VRAM watchdog, and frame N+1 cannot start before frame N's
//      pixels exist anyway. This tool blocks for a long time BY DESIGN.
//   2. SAME SEED FOR EVERY FRAME. Consistency here comes from seed + low
//      denoise + a chained reference. Per-frame randomization would defeat all
//      three. `enqueueSpriteJob` already forces `disable_random_seed: true`.
//   3. PARTIAL FAILURE IS RECORDED, NEVER THROWN. Once generation starts, a bad
//      frame produces an `AnimationFrameFailure`, the rest of THAT state's chain
//      becomes `AnimationFrameSkipped` (there are no pixels to chain from), and
//      the next motion state still runs. A wait timeout is a frame failure, not
//      a tool error.
//
// Pose changes are APPROXIMATE without ControlNet. That is the documented,
// accepted MVP tradeoff (CLAUDE.md) — `"controlnet_pose"` is rejected at the
// tool layer and is deliberately unreachable from here.
// ---------------------------------------------------------------------------

/** Injection seam, mirroring `SpriteJobDeps`. Internal — the tool passes a request only. */
export interface AnimationRunnerDeps {
  readonly resolveCheckpoint: (style: Style, override?: string) => Promise<ResolvedCheckpoint>;
  readonly enqueue: (request: SpriteJobRequest) => Promise<SpriteJobResult>;
  readonly waitForJob: (promptId: string) => Promise<SpriteJobWaitResult>;
  /** Stage a finished frame's asset back into ComfyUI's input dir for the next frame. */
  readonly stageAsset: (assetId: string) => Promise<StagedReference | undefined>;
}

const DEFAULT_DEPS: AnimationRunnerDeps = {
  resolveCheckpoint: (style, override) => resolveSpriteCheckpoint(style, override),
  enqueue: (request) => enqueueSpriteJob(request),
  waitForJob: (promptId) => waitForSpriteJob(promptId),
  stageAsset: (assetId) => resolveReferenceImage(assetId, undefined),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function chainBrokeByFailure(motionState: MotionState, frameIndex: number): string {
  return (
    `frame ${frameIndex} of "${motionState}" failed; the img2img chain stopped there ` +
    "(later frames of this state need its pixels as their reference)."
  );
}

function chainBrokeByStaging(motionState: MotionState, frameIndex: number, cause: string): string {
  return (
    `frame ${frameIndex} of "${motionState}" generated an image, but it could not be staged as ` +
    `the next frame's img2img reference (${cause}); the chain stopped there.`
  );
}

/** Roll up one state's frames into an `AnimationStateResult`, upholding its invariants. */
function summarizeState(
  motionState: MotionState,
  frames: readonly AnimationFrameResult[],
): AnimationStateResult {
  const succeededFrameCount = frames.filter((f) => f.status === "succeeded").length;
  const failedFrameCount = frames.filter((f) => f.status === "failed").length;
  const skippedFrameCount = frames.filter((f) => f.status === "skipped").length;
  return {
    motionState,
    frames,
    succeededFrameCount,
    failedFrameCount,
    skippedFrameCount,
    // Contract: chainStoppedEarly === (skippedFrameCount > 0). A failure on the
    // LAST frame breaks nothing that was still planned, so it is not "early".
    chainStoppedEarly: skippedFrameCount > 0,
  };
}

function resolveOutcome(succeeded: number, requested: number): AnimationSetOutcome {
  if (succeeded === requested) return "complete";
  if (succeeded === 0) return "failed";
  return "partial";
}

/**
 * Generate every frame of every motion state, sequentially, chaining each
 * frame's output into the next frame's img2img reference.
 *
 * Throws only if the up-front checkpoint resolution fails — i.e. before any
 * generation has happened. Everything after that is reported, not thrown.
 */
export async function runAnimationSet(
  request: AnimationSetRequest,
  deps: AnimationRunnerDeps = DEFAULT_DEPS,
): Promise<AnimationSetResult> {
  // Resolved ONCE for the whole set: every frame must sample from the same
  // weights or the set is not one character. Passed to each frame as an
  // explicit override, which `resolveSpriteCheckpoint` honours verbatim.
  const { checkpoint, familyMismatchWarning } = await deps.resolveCheckpoint(request.style, request.checkpoint);

  const states: AnimationStateResult[] = [];
  const downloadedModels: DownloadedModelInfo[] = [];

  for (let stateIndex = 0; stateIndex < request.motionStates.length; stateIndex++) {
    const motionState = request.motionStates[stateIndex];
    const frames: AnimationFrameResult[] = [];

    // Frame 0 of a state is txt2img — EXCEPT the very first frame of the very
    // first state, which starts from the caller's base image when one was
    // supplied. A caller-supplied reference therefore applies exactly once.
    let reference: string | undefined = stateIndex === 0 ? request.referenceImage : undefined;
    let chainBreakReason: string | undefined;

    for (let frameIndex = 0; frameIndex < request.framesPerState; frameIndex++) {
      if (chainBreakReason !== undefined) {
        frames.push({ status: "skipped", motionState, frameIndex, reason: chainBreakReason });
        continue;
      }

      const mode: SpriteGenerationMode = reference === undefined ? "txt2img" : "img2img";
      const jobRequest: SpriteJobRequest = {
        prompt: composeMotionFramePrompt({
          prompt: request.prompt,
          motionState,
          frameIndex,
          framesPerState: request.framesPerState,
        }),
        negativePrompt: request.negativePrompt,
        style: request.style,
        viewpoint: request.viewpoint,
        width: request.width,
        height: request.height,
        // Same seed on every single frame — see the header note.
        seed: request.seed,
        checkpoint,
        referenceImage: reference,
        // denoise is meaningless for txt2img; only send it with a reference.
        denoise: reference === undefined ? undefined : request.denoise,
        autoDownloadMissing: request.autoDownloadMissing,
        lora: request.lora,
        stepsOverride: request.stepsOverride,
        cfgOverride: request.cfgOverride,
        samplerOverride: request.samplerOverride,
        schedulerOverride: request.schedulerOverride,
      };

      let job: SpriteJobResult;
      try {
        job = await deps.enqueue(jobRequest);
        if (job.downloadedModels) downloadedModels.push(...job.downloadedModels);
      } catch (err) {
        frames.push({
          status: "failed",
          motionState,
          frameIndex,
          // No promptId: the job never made it into the queue.
          seed: request.seed,
          checkpoint,
          mode,
          error: `enqueue failed: ${errorMessage(err)}`,
        });
        chainBreakReason = chainBrokeByFailure(motionState, frameIndex);
        continue;
      }

      let waited: SpriteJobWaitResult;
      try {
        waited = await deps.waitForJob(job.promptId);
      } catch (err) {
        frames.push({
          status: "failed",
          motionState,
          frameIndex,
          promptId: job.promptId,
          seed: job.seed,
          checkpoint: job.checkpoint,
          mode: job.mode,
          error: `waiting for the frame job failed: ${errorMessage(err)}`,
        });
        chainBreakReason = chainBrokeByFailure(motionState, frameIndex);
        continue;
      }

      const failFrame = (error: string): void => {
        frames.push({
          status: "failed",
          motionState,
          frameIndex,
          promptId: job.promptId,
          seed: job.seed,
          checkpoint: job.checkpoint,
          mode: job.mode,
          error,
          errorDetails: waited.error,
        });
        chainBreakReason = chainBrokeByFailure(motionState, frameIndex);
      };

      // A timeout is a FRAME failure, not a tool error. The job is still running
      // server-side (waitForSpriteJob does not cancel it) — get_sprite_result
      // with this prompt_id can still pick the image up later.
      if (waited.timedOut) {
        failFrame(
          "timed out waiting for the frame to finish; the job was left running — " +
            "poll get_sprite_result with this prompt_id to recover the image.",
        );
        continue;
      }
      if (waited.error) {
        failFrame(`ComfyUI reported an execution error: ${waited.error.exception_message}`);
        continue;
      }
      const asset = waited.assets?.[0];
      if (asset === undefined) {
        failFrame("the job finished but registered no image asset.");
        continue;
      }

      frames.push({
        status: "succeeded",
        motionState,
        frameIndex,
        promptId: job.promptId,
        asset,
        seed: job.seed,
        checkpoint: job.checkpoint,
        mode: job.mode,
      });

      const isLastFrame = frameIndex === request.framesPerState - 1;
      if (isLastFrame) continue; // nothing left to chain into; skip a pointless upload

      // img2img needs real pixels, so the finished frame is staged back into
      // ComfyUI's input directory and referenced by BARE FILENAME.
      try {
        const staged = await deps.stageAsset(asset.assetId);
        if (staged === undefined) {
          chainBreakReason = chainBrokeByStaging(
            motionState,
            frameIndex,
            "the asset could not be resolved into a ComfyUI input",
          );
          continue;
        }
        reference = staged.filename;
      } catch (err) {
        // The frame itself succeeded — its image exists. Only the CHAIN broke.
        chainBreakReason = chainBrokeByStaging(motionState, frameIndex, errorMessage(err));
      }
    }

    states.push(summarizeState(motionState, frames));
  }

  const succeededFrameCount = states.reduce((n, s) => n + s.succeededFrameCount, 0);
  const failedFrameCount = states.reduce((n, s) => n + s.failedFrameCount, 0);
  const skippedFrameCount = states.reduce((n, s) => n + s.skippedFrameCount, 0);
  const requestedFrameCount = request.motionStates.length * request.framesPerState;

  return {
    outcome: resolveOutcome(succeededFrameCount, requestedFrameCount),
    style: request.style,
    viewpoint: request.viewpoint,
    consistencyMode: request.consistencyMode,
    checkpoint,
    seed: request.seed,
    framesPerState: request.framesPerState,
    requestedFrameCount,
    succeededFrameCount,
    failedFrameCount,
    skippedFrameCount,
    states,
    downloadedModels: downloadedModels.length > 0 ? downloadedModels : undefined,
    checkpointFamilyWarning: familyMismatchWarning,
  };
}
