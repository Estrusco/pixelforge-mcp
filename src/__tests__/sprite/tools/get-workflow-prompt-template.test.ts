import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetWorkflowPromptTemplateTool } from "../../../sprite/tools/get-workflow-prompt-template.js";
import { PROMPT_SPEC_TEMPLATE } from "../../../sprite/spec/prompt-spec-template.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = () => Promise<ToolResult>;

function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

async function getHandler(): Promise<ToolHandler> {
  const { server, tools } = fakeServer();
  registerGetWorkflowPromptTemplateTool(server);
  const handler = tools.get("get_workflow_prompt_template");
  if (!handler) throw new Error("get_workflow_prompt_template was not registered");
  return handler;
}

describe("get_workflow_prompt_template", () => {
  it("returns the template and a usage note", async () => {
    const handler = await getHandler();
    const result = await handler();

    const body = JSON.parse(result.content[0].text ?? "{}");
    expect(body.tool).toBe("get_workflow_prompt_template");
    expect(body.template).toBe(PROMPT_SPEC_TEMPLATE);
    expect(typeof body.usage_note).toBe("string");
    expect(body.usage_note.length).toBeGreaterThan(0);
  });

  it("the template includes every section header the parser recognizes, [LORA] noted as repeatable", async () => {
    const handler = await getHandler();
    const result = await handler();
    const body = JSON.parse(result.content[0].text ?? "{}");
    const template = body.template as string;

    for (const header of [
      "[CHECKPOINT / MODEL]",
      "[LORA]",
      "[SAMPLER & SCHEDULER SETTINGS]",
      "[POSITIVE PROMPT]",
      "[NEGATIVE PROMPT]",
      "[POST-PROCESSING / PIXEL PERFECT GRID]",
    ]) {
      expect(template).toContain(header);
    }
    expect(body.usage_note as string).toMatch(/more than one LoRA|repeat|duplicate/i);
    // The actual parseability of this exact text (with real values filled in)
    // is covered by the round-trip regression test in prompt-spec-parser.test.ts.
  });
});
