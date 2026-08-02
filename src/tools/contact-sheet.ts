import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContactSheet, CONTACT_SHEET_MAX_ASSETS } from "../services/contact-sheet.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerContactSheetTool(server: McpServer): void {
  server.tool(
    "contact_sheet",
    "Tile several registered assets into ONE preview PNG for batch QA — one glance instead of " +
      `N separate view_image calls. Up to ${CONTACT_SHEET_MAX_ASSETS} asset_ids. Frames need not ` +
      "share dimensions (unlike pack_spritesheet): each is centered within a uniform cell sized to " +
      "the largest frame. Defaults to a DARK background (background:'dark'), because the default " +
      "white/client-rendered transparency (view_image/get_image) makes dark-on-transparent pixel " +
      "art (e.g. a neon-on-black luma_key cutout) look faded or broken at a glance even when the " +
      "alpha is correct — pass 'light' or 'checker' to compare against those instead.",
    {
      asset_ids: z
        .array(z.string())
        .describe(`Registered asset ids to tile, in order. 1-${CONTACT_SHEET_MAX_ASSETS} entries.`),
      background: z
        .enum(["dark", "light", "checker"])
        .optional()
        .describe("Sheet backdrop (default 'dark') — composited behind every frame's alpha."),
      columns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Frames per row. Defaults to the squarest grid, ceil(sqrt(count))."),
    },
    async (args) => {
      try {
        const result = await buildContactSheet({
          assetIds: args.asset_ids,
          background: args.background,
          columns: args.columns,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "ok",
                  tool: "contact_sheet",
                  count: result.count,
                  columns: result.columns,
                  rows: result.rows,
                  cell_width: result.cellWidth,
                  cell_height: result.cellHeight,
                  sheet_width: result.sheetWidth,
                  sheet_height: result.sheetHeight,
                  background: args.background ?? "dark",
                  labels: result.labels,
                },
                null,
                2,
              ),
            },
            { type: "image" as const, data: result.png.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
