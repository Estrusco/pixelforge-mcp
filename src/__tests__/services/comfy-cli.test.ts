import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertComfyCliOk,
  parseComfyCliEnvelope,
  resolveComfyCliExecutable,
} from "../../services/comfy-cli.js";

const originalCliPath = process.env.COMFY_CLI_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalCliPath === undefined) delete process.env.COMFY_CLI_PATH;
  else process.env.COMFY_CLI_PATH = originalCliPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("comfy-cli adapter", () => {
  it("parses the final envelope after NDJSON events", () => {
    const envelope = parseComfyCliEnvelope<{ jobs: number }>(
      '{"schema":"event/1","type":"progress"}\n' +
        '{"schema":"envelope/1","type":"envelope","ok":true,"command":"jobs ls","version":"1.11.1","where":"local","data":{"jobs":2},"error":null}\n',
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.version).toBe("1.11.1");
    expect(envelope.data).toEqual({ jobs: 2 });
  });

  it("rejects non-envelope JSON", () => {
    expect(() => parseComfyCliEnvelope('{"ok":"yes"}')).toThrow(/envelope\/1/);
  });

  it("surfaces structured CLI errors", () => {
    const envelope = parseComfyCliEnvelope(
      '{"ok":false,"command":"validate","version":"1.11.1","where":"local","data":null,"error":{"code":"workflow_invalid_json","message":"bad JSON","hint":"re-export"}}',
    );
    expect(() => assertComfyCliOk(envelope)).toThrow(/workflow_invalid_json: bad JSON \(re-export\)/);
  });

  it("honors COMFY_CLI_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "comfy-cli-test-"));
    tempDirs.push(dir);
    const executable = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(executable, "");
    process.env.COMFY_CLI_PATH = executable;
    expect(resolveComfyCliExecutable()).toBe(executable);
  });
});
