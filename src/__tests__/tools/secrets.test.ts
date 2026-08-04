import { beforeEach, describe, expect, it, vi } from "vitest";

const setPanelSecretMock = vi.fn();
const clearPanelSecretMock = vi.fn();
const listPanelSecretsMaskedMock = vi.fn();

vi.mock("../../services/panel-secrets.js", () => ({
  CREDENTIAL_SLOTS: [
    { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
    { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
    { id: "runpod", label: "RunPod", envKeys: ["RUNPOD_API_KEY"], store: "comfyui", help: "Manage GPU pods" },
    { id: "openrouter", label: "OpenRouter", envKeys: ["OPENROUTER_API_KEY"], store: "agent", help: "Hosted models" },
  ],
  setPanelSecret: (...args: unknown[]) => setPanelSecretMock(...args),
  clearPanelSecret: (...args: unknown[]) => clearPanelSecretMock(...args),
  listPanelSecretsMasked: (...args: unknown[]) => listPanelSecretsMaskedMock(...args),
  maskSecret: (v: string) => (v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-3)}`),
}));

import { registerSecretsTools } from "../../tools/secrets.js";
import { config } from "../../config.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerSecretsTools(server as never);
  return handlers;
}

function parse(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  setPanelSecretMock.mockReset();
  clearPanelSecretMock.mockReset();
  listPanelSecretsMaskedMock.mockReset();
  config.civitaiApiToken = undefined;
  config.huggingfaceToken = undefined;
});

describe("secrets tools", () => {
  it("wires all three tools", () => {
    const handlers = makeServer();
    expect(handlers.has("get_secrets")).toBe(true);
    expect(handlers.has("set_secret")).toBe(true);
    expect(handlers.has("clear_secret")).toBe(true);
  });

  it("get_secrets never returns a raw value, only masked status + help", async () => {
    listPanelSecretsMaskedMock.mockReturnValueOnce([
      { id: "civitai", label: "Civitai", set: true, masked: "1a2b…f9c" },
      { id: "runpod", label: "RunPod", set: false, masked: null },
    ]);
    const handlers = makeServer();
    const result = await handlers.get("get_secrets")!({});
    const payload = parse(result) as { count: number; secrets: Array<Record<string, unknown>> };
    expect(payload.count).toBe(2);
    for (const s of payload.secrets) {
      expect(Object.keys(s).sort()).toEqual(["help", "id", "label", "masked", "set"]);
    }
    expect(payload.secrets[0]).toEqual({ id: "civitai", label: "Civitai", set: true, masked: "1a2b…f9c", help: "Model downloads" });
  });

  it("set_secret rejects an unknown slot", async () => {
    const handlers = makeServer();
    setPanelSecretMock.mockImplementationOnce(() => {
      throw new Error('unknown credential slot "bogus"');
    });
    const result = await handlers.get("set_secret")!({ slot: "bogus", value: "x" });
    expect(result.isError).toBe(true);
  });

  it("clear_secret rejects an unknown slot", async () => {
    const handlers = makeServer();
    clearPanelSecretMock.mockImplementationOnce(() => {
      throw new Error('unknown credential slot "bogus"');
    });
    const result = await handlers.get("clear_secret")!({ slot: "bogus" });
    expect(result.isError).toBe(true);
  });

  it("set_secret for civitai persists and live-patches config, never echoing the raw value", async () => {
    const handlers = makeServer();
    const result = await handlers.get("set_secret")!({ slot: "civitai", value: "tok-abc" });
    expect(setPanelSecretMock).toHaveBeenCalledWith("civitai", "tok-abc");
    const payload = parse(result) as { status: string; masked: string };
    expect(payload.status).toBe("set");
    expect(payload.masked).not.toBe("tok-abc");
    expect(JSON.stringify(payload)).not.toContain("tok-abc");
    expect(config.civitaiApiToken).toBe("tok-abc");
  });

  it("clear_secret for civitai resets the live config field", async () => {
    const handlers = makeServer();
    config.civitaiApiToken = "tok-abc";
    clearPanelSecretMock.mockReturnValueOnce(true);
    const result = await handlers.get("clear_secret")!({ slot: "civitai" });
    expect(clearPanelSecretMock).toHaveBeenCalledWith("civitai");
    expect(parse(result)).toMatchObject({ status: "cleared" });
    expect(config.civitaiApiToken).toBeUndefined();
  });

  it("set_secret / clear_secret for huggingface live-patch config.huggingfaceToken", async () => {
    const handlers = makeServer();
    await handlers.get("set_secret")!({ slot: "huggingface", value: "hf-tok" });
    expect(config.huggingfaceToken).toBe("hf-tok");
    clearPanelSecretMock.mockReturnValueOnce(true);
    await handlers.get("clear_secret")!({ slot: "huggingface" });
    expect(config.huggingfaceToken).toBeUndefined();
  });

  it("set_secret for a slot with no config.ts mapping does not touch config.*", async () => {
    const handlers = makeServer();
    await handlers.get("set_secret")!({ slot: "runpod", value: "rp-tok" });
    expect(config.civitaiApiToken).toBeUndefined();
    expect(config.huggingfaceToken).toBeUndefined();
  });
});
