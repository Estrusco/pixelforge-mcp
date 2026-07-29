import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  removeBackground,
  REMBG_NODE,
  type RemoveBackgroundDeps,
} from "../services/remove-background.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { resolveReferenceImage } from "../sprite/reference-image.js";

async function isNodeInstalled(classType: string): Promise<boolean | undefined> {
  try {
    const objectInfo = await getObjectInfo();
    return Object.prototype.hasOwnProperty.call(objectInfo, classType);
  } catch {
    // Can't reach the server / object_info — let execution surface any problem.
    return undefined;
  }
}

const deps: RemoveBackgroundDeps = {
  isNodeInstalled,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

interface RemoveBackgroundToolArgs {
  image?: string;
  asset_id?: string;
  path?: string;
  model?: string;
  filename_prefix?: string;
}

/**
 * Resolve exactly one of image / asset_id / path into a bare filename already
 * present in ComfyUI's input directory. asset_id and path are staged via the
 * same resolveReferenceImage() helper generate_sprite and friends use, so
 * "already an input" assets are reused as-is and outputs/paths are uploaded
 * once and re-referenced deterministically.
 */
async function resolveImageFilename(args: RemoveBackgroundToolArgs): Promise<string> {
  const provided = [args.image, args.asset_id, args.path].filter((v) => v !== undefined);
  if (provided.length !== 1) {
    throw new ValidationError("Provide exactly one image source: image, asset_id, or path.");
  }
  if (args.image !== undefined) return args.image;
  const staged = await resolveReferenceImage(args.asset_id, args.path);
  // resolveImageFilename only reaches here when asset_id xor path was set, so
  // resolveReferenceImage always returns a StagedReference (never undefined).
  return staged!.filename;
}

export function registerRemoveBackgroundTool(server: McpServer): void {
  server.tool(
    "remove_background",
    "Remove an image's background, returning a transparent (RGBA) cutout — the high-level entry point. " +
      `Builds a LoadImage → ${REMBG_NODE} → SaveImage workflow using the ComfyUI-RMBG (BiRefNet) matting ` +
      "node and enqueues it on your LOCAL GPU. Provide exactly one image source: image (a filename already " +
      "in ComfyUI's input dir — upload it first with upload_image, or stage a prior output with " +
      "stage_output_as_input), asset_id (a registered asset id from a completed job), or path (a filesystem " +
      "path, absolute or relative to the ComfyUI output directory). Requires the ComfyUI-RMBG custom node " +
      "(pack: wan-transparent, or install_custom_node 'comfyui-rmbg'); the BiRefNet model auto-downloads on " +
      "first run. If the node isn't installed, returns an actionable error telling you how to install it. " +
      "Returns prompt_id immediately; the cutout asset_id arrives in the completion notification.",
    {
      image: z
        .string()
        .optional()
        .describe(
          "Filename of the source image in ComfyUI's input dir (upload it first with upload_image). " +
            "Provide exactly one of image, asset_id, or path.",
        ),
      asset_id: z
        .string()
        .optional()
        .describe(
          "Registered asset id from a completed job. Provide exactly one of image, asset_id, or path.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Path to a source image: absolute, or relative to the ComfyUI output directory. " +
            "Provide exactly one of image, asset_id, or path.",
        ),
      model: z
        .string()
        .optional()
        .describe("BiRefNet matting model (default 'BiRefNet_toonout'; auto-downloaded by ComfyUI-RMBG)"),
      filename_prefix: z
        .string()
        .optional()
        .describe("Output filename prefix (default 'ComfyUI_cutout')"),
    },
    async (args: RemoveBackgroundToolArgs) => {
      try {
        const image = await resolveImageFilename(args);
        const result = await removeBackground(
          { image, model: args.model, filename_prefix: args.filename_prefix },
          deps,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: "remove_background",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  model: result.model,
                  note: "Transparent cutout asset_id arrives in the completion notification; use view_image with it.",
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
