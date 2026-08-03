import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../../utils/errors.js";
import { PROMPT_SPEC_TEMPLATE, PROMPT_SPEC_USAGE_NOTE } from "../spec/prompt-spec-template.js";

// ---------------------------------------------------------------------------
// get_workflow_prompt_template — a thin, static-content wrapper: no ComfyUI
// call, no queue, nothing that can actually throw. It exists so an agent (or
// a user) can discover the exact prompt-spec syntax without reading source —
// fetch this, fill in the placeholders, then call workflow_from_prompt_spec.
// The template text itself lives in ../spec/prompt-spec-template.js, co-
// located with the parser so the two can't drift apart.
// ---------------------------------------------------------------------------

export function registerGetWorkflowPromptTemplateTool(server: McpServer): void {
  server.tool(
    "get_workflow_prompt_template",
    "Return the fillable text template for workflow_from_prompt_spec's prompt-spec format — the " +
      "exact section/key syntax ([CHECKPOINT / MODEL], optional [LORA] (repeatable for more than " +
      "one LoRA), [SAMPLER & SCHEDULER SETTINGS], [POSITIVE PROMPT], optional [NEGATIVE PROMPT], " +
      "optional [POST-PROCESSING / PIXEL PERFECT GRID]). Fetch this first, replace every " +
      "<placeholder> with real values (an end user's description of what they want translated into " +
      "checkpoint/LoRA/sampler/prompt choices), then pass the filled text as spec_text to " +
      "workflow_from_prompt_spec.",
    {},
    async () => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  tool: "get_workflow_prompt_template",
                  template: PROMPT_SPEC_TEMPLATE,
                  usage_note: PROMPT_SPEC_USAGE_NOTE,
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
