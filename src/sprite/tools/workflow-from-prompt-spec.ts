import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import { parsePromptSpec } from "../spec/prompt-spec-parser.js";
import { buildAndSaveSpecWorkflow } from "../spec/spec-job.js";
import type { SpecWorkflowRequest } from "../spec/spec-job.js";

// ---------------------------------------------------------------------------
// workflow_from_prompt_spec — the MCP contract layer.
//
// This file owns ONLY: argument validation, reading the spec file off disk,
// and response formatting. Everything else is delegated:
//   - text -> PromptSpec            -> ../spec/prompt-spec-parser.js
//   - checkpoint/VAE/LoRA resolution, graph construction, validation,
//     auto-download, save-to-ComfyUI-library -> ../spec/spec-job.js
//
// Unlike generate_sprite, this tool NEVER enqueues/runs the workflow — it only
// builds, resolves, validates, and saves it into the connected ComfyUI
// server's workflow library so it opens in the web UI exactly as if a person
// had built it there by hand. Use the existing generic enqueue_workflow tool
// to actually run it (pixelforge-mcp-n0f, confirmed with the user).
// ---------------------------------------------------------------------------

const loraSourceSchema = z
  .object({
    civitai_model_id: z.number().optional().describe("CivitAI model id (resolves to its primary file)."),
    civitai_version_id: z
      .number()
      .optional()
      .describe("CivitAI model-VERSION id — preferred over civitai_model_id when both are known."),
    huggingface_repo: z.string().optional().describe("HuggingFace repo id, e.g. 'nerijs/pixel-art-xl'."),
    huggingface_filename: z
      .string()
      .optional()
      .describe("Exact filename inside huggingface_repo — not a search term."),
  })
  .describe(
    "Explicit, exact download source for the spec's [LORA], used only when auto_download_missing " +
      "is true and it isn't installed. Set civitai_version_id (preferred), civitai_model_id, or both " +
      "huggingface_repo + huggingface_filename to fetch EXACTLY that file — never a keyword search, " +
      "never a 'similar' substitute. Omit to rely on an exact-filename search match instead.",
  );

const workflowFromPromptSpecSchema = {
  spec_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to a prompt-spec text file (checkpoint + optional alternate, optional VAE, " +
        "optional [LORA], [SAMPLER & SCHEDULER SETTINGS], [POSITIVE PROMPT], [NEGATIVE PROMPT], " +
        "optional [POST-PROCESSING / PIXEL PERFECT GRID]). Exactly one of spec_path / spec_text is required.",
    ),
  spec_text: z
    .string()
    .optional()
    .describe("Prompt-spec text given inline instead of spec_path. Exactly one of the two is required."),
  filename: z
    .string()
    .optional()
    .describe(
      "Filename to save the built workflow as in the ComfyUI user library (e.g. 'my_spec.json'). " +
        "Defaults to spec_path's basename with a .json extension, or 'prompt_spec_workflow.json' " +
        "when using spec_text. Overwrites an existing file with the same name.",
    ),
  auto_download_missing: z
    .boolean()
    .optional()
    .describe(
      "Explicit opt-in (default false — NEVER silent): if the resolved checkpoint, the spec's VAE, " +
        "or its LoRA aren't actually installed, download them before saving instead of saving a " +
        "workflow ComfyUI will only reject later. Checkpoint/VAE: best-ranked CivitAI/HuggingFace " +
        "candidate. LoRA: 'lora_source' when given is fetched EXACTLY (no ranking); without a " +
        "source, only an exact filename match is used — never a 'similar' substitute. Reports what " +
        "was downloaded in the result. If nothing installable is found, fails with an actionable " +
        "error instead of saving a broken graph.",
    ),
  lora_source: loraSourceSchema.optional(),
};

type WorkflowFromPromptSpecArgs = {
  spec_path?: string;
  spec_text?: string;
  filename?: string;
  auto_download_missing?: boolean;
  lora_source?: {
    civitai_model_id?: number;
    civitai_version_id?: number;
    huggingface_repo?: string;
    huggingface_filename?: string;
  };
};

/** "C:\foo\my spec.txt" -> "my spec.json" */
function deriveFilename(specPath: string): string {
  const base = basename(specPath);
  const ext = extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}.json`;
}

export function registerWorkflowFromPromptSpecTool(server: McpServer): void {
  server.tool(
    "workflow_from_prompt_spec",
    "Build a complete ComfyUI workflow from a structured plain-text prompt-spec file — the kind a " +
      "human would hand-author for a single generation (checkpoint + optional alternate, optional " +
      "separate VAE, optional LoRA with weights/trigger words, sampler/scheduler/steps/cfg/" +
      "resolution, positive/negative prompt, optional pixel-grid post-processing described as " +
      "downscale-then-upscale ImageScale steps). Wires CheckpointLoaderSimple -> (VAELoader) -> " +
      "(LoraLoader) -> CLIPTextEncode (positive/negative) -> KSampler -> VAEDecode -> (pixel-grid " +
      "ImageScale down/up) -> SaveImage, then SAVES it into the connected ComfyUI server's workflow " +
      "library so it opens in the web UI exactly like a hand-built graph. Does NOT enqueue or run " +
      "the workflow — use enqueue_workflow separately once you've reviewed it (or load it in the " +
      "ComfyUI canvas and press Queue). Provide exactly one of spec_path / spec_text.",
    workflowFromPromptSpecSchema,
    async (args: WorkflowFromPromptSpecArgs) => {
      try {
        if (Boolean(args.spec_path) === Boolean(args.spec_text)) {
          throw new ValidationError("Provide exactly one of spec_path or spec_text.");
        }

        const text = args.spec_path ? await readFile(args.spec_path, "utf-8") : args.spec_text!;
        const spec = parsePromptSpec(text);
        const filename = args.filename ?? (args.spec_path ? deriveFilename(args.spec_path) : "prompt_spec_workflow.json");

        const request: SpecWorkflowRequest = {
          spec,
          filename,
          autoDownloadMissing: args.auto_download_missing,
          loraSource: args.lora_source
            ? {
                civitaiModelId: args.lora_source.civitai_model_id,
                civitaiVersionId: args.lora_source.civitai_version_id,
                huggingfaceRepo: args.lora_source.huggingface_repo,
                huggingfaceFilename: args.lora_source.huggingface_filename,
              }
            : undefined,
        };

        const result = await buildAndSaveSpecWorkflow(request);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "saved",
                  tool: "workflow_from_prompt_spec",
                  filename: result.filename,
                  checkpoint: result.checkpoint,
                  vae: result.vae,
                  lora: result.lora,
                  sampler: spec.sampler,
                  scheduler: spec.scheduler,
                  steps: spec.steps,
                  cfg: spec.cfg,
                  width: spec.width,
                  height: spec.height,
                  pixel_grid: spec.postProcess,
                  downloaded_models: result.downloadedModels,
                  save_message: result.saveMessage,
                  note:
                    "Saved, not enqueued — open it in the ComfyUI web UI's Workflows menu, or call " +
                    "enqueue_workflow with get_workflow's output to run it.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
