import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry, applyOverrides, isLocalAsset, type AssetRecord } from "../services/asset-registry.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { viewAssetImage } from "../services/view-image.js";
import { ValidationError, errorToToolResult } from "../utils/errors.js";

/**
 * "<image-stem>.workflow.json" — recognizable next to the image it came from
 * when both end up in the same project folder.
 */
function deriveWorkflowSnapshotFilename(record: AssetRecord): string {
  const stem = basename(record.filename, extname(record.filename));
  return `${stem || record.assetId}.workflow.json`;
}

/**
 * Write an asset's workflow snapshot to an arbitrary local directory (no
 * COMFYUI_PATH dependency, no containment check — the caller explicitly
 * chose this location, e.g. a game project folder). Mirrors pixelate_image's
 * save_dir (src/sprite/image-io.ts resolveSaveDir).
 */
async function saveWorkflowSnapshot(record: AssetRecord, saveDir: string): Promise<string> {
  if (isLocalAsset(record)) {
    throw new ValidationError(
      `Asset "${record.assetId}" was registered from a local file (e.g. pixelate_image), not a ` +
        "ComfyUI job — there is no workflow to save.",
    );
  }
  const dir = resolve(saveDir);
  await mkdir(dir, { recursive: true });
  const savePath = join(dir, deriveWorkflowSnapshotFilename(record));
  await writeFile(savePath, JSON.stringify(record.workflow, null, 2));
  return savePath;
}

function summarizeRecord(record: ReturnType<typeof AssetRegistry.get>) {
  if (!record) return null;
  return {
    asset_id: record.assetId,
    prompt_id: record.promptId,
    node_id: record.nodeId,
    filename: record.filename,
    subfolder: record.subfolder,
    type: record.type,
    url: record.url,
    created_at: new Date(record.createdAt).toISOString(),
  };
}

export function registerAssetTools(server: McpServer): void {
  server.tool(
    "view_image",
    "Fetch a registered asset's bytes and return them as an inline image so the agent can see the result. Use this after enqueue_workflow completes (asset_id is included in the completion notification) to inspect, critique, or compare generated images. Only supports image mime types (PNG/JPEG/WebP); audio/video assets must be saved to disk via get_image. By default transparency composites onto whatever background the client renders (often white), which makes dark-on-transparent art (e.g. a neon-on-black luma_key cutout) look faded or broken at a glance even when the alpha is correct — pass background:'dark'/'light'/'checker' to composite it server-side onto a deliberate backdrop instead (always returned as PNG).",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
      background: z
        .enum(["dark", "light", "checker"])
        .optional()
        .describe(
          "Composite the image onto this backdrop before returning it (always PNG). Omit to " +
            "return the raw bytes as-is (client renders transparency however it wants).",
        ),
    },
    async ({ asset_id, background }) => {
      try {
        const result = await viewAssetImage(asset_id, background);
        return {
          content: result.content.map((block) =>
            block.type === "image"
              ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
              : { type: "text" as const, text: block.text },
          ),
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_assets",
    "List recently generated assets from the in-memory registry, newest-first. Assets are registered automatically when a workflow completes successfully. The registry is ephemeral and clears on server restart; records expire after COMFYUI_ASSET_TTL_HOURS (default 24h).",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max records to return (default: all)"),
      since: z
        .string()
        .datetime()
        .optional()
        .describe("ISO timestamp — only return assets created at or after this time"),
    },
    async (args) => {
      try {
        const since = args.since ? Date.parse(args.since) : undefined;
        const records = AssetRegistry.list({ limit: args.limit, since });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: records.length, assets: records.map(summarizeRecord) },
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

  server.tool(
    "get_asset_metadata",
    "Get full provenance for a registered asset including the workflow snapshot that produced it. Use this to inspect the parameters that generated an image before calling regenerate with overrides. The registry this reads from is in-memory only (default 24h TTL, wiped on server restart) — pass save_dir to also persist the workflow snapshot (with its exact seed and parameters) to an arbitrary local directory, e.g. a folder inside your game project, so you can reproduce or vary that image later even after the registry entry is gone.",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
      save_dir: z
        .string()
        .optional()
        .describe(
          "Optional local directory (arbitrary path — not required to be under COMFYUI_PATH, e.g. " +
            "a folder inside your game project) to also write this asset's workflow snapshot to, as " +
            "'<image-stem>.workflow.json'. Created if missing. Fails if the asset has no real " +
            "workflow behind it (e.g. registered by pixelate_image).",
        ),
    },
    async ({ asset_id, save_dir }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        const savedTo = save_dir ? await saveWorkflowSnapshot(record, save_dir) : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...summarizeRecord(record),
                  ...(savedTo ? { saved_to: savedTo } : {}),
                  workflow: record.workflow,
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

  server.tool(
    "regenerate",
    "Re-enqueue the workflow that produced an existing asset, optionally applying parameter overrides. Overrides are applied to any node input matching the key name (e.g. cfg, steps, sampler_name, scheduler, seed, denoise, text). Seeds are re-randomized by default so each regenerate yields a fresh image unless seed is explicitly passed in overrides.",
    {
      asset_id: z.string().describe("Asset id of the source generation"),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Map of input-name → new value applied to every node that already has that input. " +
            "Common keys: cfg, steps, sampler_name, scheduler, seed, denoise, text.",
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe(
          "If true, do not randomize seed fields. Combine with `overrides.seed` to reproduce the exact original image.",
        ),
    },
    async ({ asset_id, overrides, disable_random_seed }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        if (isLocalAsset(record)) {
          return errorToToolResult(
            new ValidationError(
              `Asset "${asset_id}" was registered from a local file (e.g. pixelate_image), not a ` +
                "ComfyUI job — there is no workflow to re-enqueue.",
            ),
          );
        }
        const next = applyOverrides(record.workflow, overrides);
        const result = await enqueueWorkflow(next, { disable_random_seed });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  source_asset_id: asset_id,
                  overrides_applied: overrides ?? {},
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
