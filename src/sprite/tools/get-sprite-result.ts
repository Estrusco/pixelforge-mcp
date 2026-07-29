import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../../utils/errors.js";
import { resolveSpriteJobStatus } from "../comfyui/index.js";

// ---------------------------------------------------------------------------
// get_sprite_result — a thin wrapper over the INHERITED get_job_status
// (src/services/queue-manager.ts), specialized for jobs enqueued by
// generate_sprite (and, by design, generate_animation_set /
// generate_arcade_topdown_set, which build on the same job shape).
//
// The status query + asset resolution (once done with no error, resolve the
// produced image asset(s) via AssetRegistry.list() filtered by promptId) live
// in `resolveSpriteJobStatus` (src/sprite/comfyui/sprite-status.ts), shared
// with the blocking `waitForSpriteJob` poll loop used elsewhere in the sprite
// layer. This file owns no queue logic and no polling of its own — the caller
// re-invokes this tool to poll.
// ---------------------------------------------------------------------------

export function registerGetSpriteResultTool(server: McpServer): void {
  server.tool(
    "get_sprite_result",
    "Check the status of a sprite job started by generate_sprite (or generate_animation_set / " +
      "generate_arcade_topdown_set) by its prompt_id. Thin wrapper over the inherited get_job_status: " +
      "while the job is still running or pending, this returns just the status so the caller knows " +
      "to keep polling. Once the job is done with no error, it also resolves the produced image " +
      "asset(s) from the asset registry — pass the returned asset_id straight to view_image, " +
      "pixelate_image, or generate_animation_set's reference image parameter.",
    {
      prompt_id: z.string().describe("The prompt_id returned by generate_sprite."),
    },
    async ({ prompt_id }: { prompt_id: string }) => {
      try {
        const result = await resolveSpriteJobStatus(prompt_id);

        const note = !result.done
          ? "Job not finished yet; poll again with the same prompt_id."
          : result.error
            ? "Job finished with an error; see `error` for details."
            : result.assets && result.assets.length > 0
              ? "Pass `assets[].asset_id` to view_image, pixelate_image, or generate_animation_set."
              : "Job finished but no image asset was found for this prompt_id.";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  prompt_id: result.promptId,
                  running: result.running,
                  pending: result.pending,
                  done: result.done,
                  status_str: result.statusStr,
                  error: result.error,
                  execution_stats: result.executionStats,
                  assets: result.assets?.map((asset) => ({
                    asset_id: asset.assetId,
                    filename: asset.filename,
                    subfolder: asset.subfolder,
                  })),
                  note,
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
