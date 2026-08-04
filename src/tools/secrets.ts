import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CREDENTIAL_SLOTS,
  setPanelSecret,
  clearPanelSecret,
  listPanelSecretsMasked,
  maskSecret,
} from "../services/panel-secrets.js";
import { config } from "../config.js";
import { errorToToolResult } from "../utils/errors.js";

// The plain stdio MCP server (npx comfyui-mcp with no panel attached) has no
// equivalent of the orchestrator's panel_request_secret — a plain-MCP user's
// only prior option was hand-editing ~/.comfyui-mcp/.env or their MCP client's
// env block. These three tools expose the SAME storage/allowlist engine the
// panel uses (src/services/panel-secrets.ts) directly on the tool surface.

const SLOT_IDS = CREDENTIAL_SLOTS.map((s) => s.id);
// z.enum needs a literal tuple type; CREDENTIAL_SLOTS is a runtime array, so
// this cast is safe only because the array is always non-empty at module load.
const slotIdSchema = z.enum(SLOT_IDS as [string, ...string[]]);

const slotList = CREDENTIAL_SLOTS.map((s) => `${s.id} (${s.label}${s.help ? " — " + s.help : ""})`).join(", ");
const helpById = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s.help ?? null]));
const slotById = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s]));

// config.ts snapshots process.env once into a frozen-shaped (but mutable)
// object at module load (config.ts:479) — setPanelSecret/clearPanelSecret
// already mutate process.env live, but that does NOT retroactively update an
// already-read config.* field in THIS process. Patch the two fields config.ts
// exposes directly so the change applies immediately, without an MCP
// reconnect. Mirrors the pattern already used in civitai-resolver.test.ts.
// Other slots either have no config.ts field (google — no confirmed live
// consumer in the comfyui tool surface today, only in the orchestrator's LLM
// backends, a different subsystem) or read process.env directly at call time
// (e.g. runpod, see services/runpod-client.ts) and so already apply live.
function applyLiveConfigPatch(slot: string, value: string | undefined): void {
  if (slot === "civitai") config.civitaiApiToken = value;
  if (slot === "huggingface") config.huggingfaceToken = value;
}

export function registerSecretsTools(server: McpServer): void {
  server.tool(
    "get_secrets",
    "List every credential slot this server can store (civitai, huggingface, google, runcomfy, runpod, " +
      "registry, openrouter, and derived agent-provider keys) with masked status only — never a raw value. " +
      "Use before set_secret to see current state and valid slot ids.",
    {},
    async () => {
      try {
        const secrets = listPanelSecretsMasked().map((m) => ({ ...m, help: helpById.get(m.id) ?? null }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: secrets.length, secrets }, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "set_secret",
    "Set a credential slot (e.g. a CivitAI or HuggingFace API token) so this server's tools can use it. " +
      `Valid slots: ${slotList}. Persists to ~/.comfyui-mcp/.env (0600) and applies live in this session for ` +
      "civitai/huggingface; other slots already apply live on next use. CAVEAT: `value` passes through the " +
      "normal MCP tool-call path like any other argument — it is NOT a masked/secure input channel the way the " +
      "panel UI's key entry is. Still strictly better than hand-editing the raw token into a JSON config file " +
      "with no masking on read-back at all.",
    {
      slot: slotIdSchema.describe(`Credential slot id. One of: ${slotList}`),
      value: z.string().min(1).describe("The raw secret value. Never echoed back — only a masked confirmation is returned."),
    },
    async ({ slot, value }) => {
      try {
        setPanelSecret(slot, value);
        applyLiveConfigPatch(slot, value);
        const meta = slotById.get(slot)!;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id: slot, label: meta.label, status: "set", masked: maskSecret(value) }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "clear_secret",
    `Remove a stored credential slot. Valid slots: ${slotList}.`,
    {
      slot: slotIdSchema.describe(`Credential slot id. One of: ${slotList}`),
    },
    async ({ slot }) => {
      try {
        const removed = clearPanelSecret(slot);
        applyLiveConfigPatch(slot, undefined);
        const meta = slotById.get(slot)!;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id: slot, label: meta.label, status: removed ? "cleared" : "already_unset" }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
