import type { WorkflowJSON } from "../../comfyui/types.js";
import { getNextNodeId } from "../../services/workflow-composer.js";
import { WorkflowExecutionError } from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Small, generic graph-editing helpers shared by anything that mutates an
// already-built ComfyUI workflow JSON (sprite-workflow.ts, spec-workflow.ts).
// Every helper here rewires by CONNECTION, never by hardcoded node id, so it
// works unchanged regardless of which template produced the graph.
// ---------------------------------------------------------------------------

/** Find the id of the first node of `classType`, or throw if none exists. */
export function findNodeId(workflow: WorkflowJSON, classType: string): string {
  const id = Object.keys(workflow).find((key) => workflow[key].class_type === classType);
  if (id === undefined) {
    throw new WorkflowExecutionError(`Workflow is missing an expected ${classType} node.`);
  }
  return id;
}

export interface LoraSpec {
  readonly name: string;
  readonly strengthModel?: number;
  readonly strengthClip?: number;
}

/**
 * Insert a `LoraLoader` between `CheckpointLoaderSimple` and everything that
 * consumed its `model`/`clip` outputs (KSampler, both CLIPTextEncode nodes).
 * The checkpoint's VAE output (index 2) is untouched: `LoraLoader` never sees
 * or passes it through.
 */
export function insertLora(workflow: WorkflowJSON, lora: LoraSpec, title = "LoRA"): void {
  const ckptId = findNodeId(workflow, "CheckpointLoaderSimple");
  const loraId = getNextNodeId(workflow);
  const strengthModel = lora.strengthModel ?? 1.0;
  const strengthClip = lora.strengthClip ?? strengthModel;

  workflow[loraId] = {
    class_type: "LoraLoader",
    inputs: {
      model: [ckptId, 0],
      clip: [ckptId, 1],
      lora_name: lora.name,
      strength_model: strengthModel,
      strength_clip: strengthClip,
    },
    _meta: { title },
  };

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (nodeId === loraId) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value[0] !== ckptId) continue;
      if (value[1] === 0) node.inputs[key] = [loraId, 0];
      else if (value[1] === 1) node.inputs[key] = [loraId, 1];
    }
  }
}

/**
 * Insert a `VAELoader` and repoint every consumer of the checkpoint's bundled
 * VAE output (index 2) at it instead — used when a spec names a separate VAE
 * file rather than relying on the checkpoint's own baked-in VAE.
 */
export function insertVae(workflow: WorkflowJSON, vaeName: string, title = "VAE"): void {
  const ckptId = findNodeId(workflow, "CheckpointLoaderSimple");
  const vaeId = getNextNodeId(workflow);

  workflow[vaeId] = {
    class_type: "VAELoader",
    inputs: { vae_name: vaeName },
    _meta: { title },
  };

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (nodeId === vaeId) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value[0] !== ckptId || value[1] !== 2) continue;
      node.inputs[key] = [vaeId, 0];
    }
  }
}
