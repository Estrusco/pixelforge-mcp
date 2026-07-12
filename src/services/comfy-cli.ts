import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { config } from "../config.js";

export interface ComfyCliError {
  code: string;
  message: string;
  hint?: string | null;
  details?: unknown;
}

export interface ComfyCliEnvelope<T = unknown> {
  schema?: string;
  type?: string;
  ok: boolean;
  command: string;
  version: string;
  where: "local" | "cloud" | null;
  data: T | null;
  error: ComfyCliError | null;
}

export interface ComfyCliRunOptions {
  workspace?: string | null;
  where?: "local" | "cloud";
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["comfy.exe", "comfy.cmd", "comfy"] : ["comfy"];
}

function workspaceCandidates(workspace?: string | null): string[] {
  if (!workspace) return [];
  const roots = [workspace, dirname(workspace)];
  const dirs = roots.flatMap((root) => [
    join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
    join(root, "venv", process.platform === "win32" ? "Scripts" : "bin"),
  ]);
  return dirs.flatMap((dir) => executableNames().map((name) => join(dir, name)));
}

/** Resolve comfy-cli without invoking a shell. COMFY_CLI_PATH is authoritative. */
export function resolveComfyCliExecutable(options: { refresh?: boolean; workspace?: string | null } = {}): string | null {
  const explicit = process.env.COMFY_CLI_PATH?.trim();
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }

  const workspace = options.workspace ?? config.comfyuiPath;
  for (const candidate of workspaceCandidates(workspace)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function buildArgs(args: readonly string[], options: ComfyCliRunOptions): string[] {
  const result = ["--json"];
  const workspace = options.workspace === undefined ? config.comfyuiPath : options.workspace;
  if (workspace) result.push("--workspace", workspace);
  if (options.where) result.push("--where", options.where);
  result.push("--skip-prompt", ...args);
  return result;
}

export function parseComfyCliEnvelope<T>(stdout: string, stderr = "", exitCode?: number): ComfyCliEnvelope<T> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let parsed: unknown;
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      parsed = JSON.parse(lines[index]);
      break;
    } catch {
      // JSON streaming commands may emit events before the final envelope.
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`comfy-cli did not return a JSON envelope${exitCode == null ? "" : ` (exit ${exitCode})`}: ${stderr || stdout}`);
  }
  const envelope = parsed as Partial<ComfyCliEnvelope<T>>;
  if (typeof envelope.ok !== "boolean" || typeof envelope.command !== "string" || typeof envelope.version !== "string") {
    throw new Error("comfy-cli returned JSON that does not match envelope/1");
  }
  return envelope as ComfyCliEnvelope<T>;
}

function requireExecutable(options: ComfyCliRunOptions): string {
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  if (!executable) {
    throw new Error(
      "comfy-cli was not found. Install comfy-cli>=1.11.1 and ensure `comfy` is on PATH, " +
        "set COMFY_CLI_PATH, or install it in the selected ComfyUI workspace's .venv.",
    );
  }
  return executable;
}

export async function runComfyCli<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): Promise<ComfyCliEnvelope<T>> {
  const executable = requireExecutable(options);
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(
        executable,
        buildArgs(args, options),
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: "1", ...options.env },
        },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
    return parseComfyCliEnvelope<T>(result.stdout, result.stderr);
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string; code?: number };
    if (processError.stdout) return parseComfyCliEnvelope<T>(processError.stdout, processError.stderr ?? "", processError.code);
    throw error;
  }
}

export function runComfyCliSync<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): ComfyCliEnvelope<T> {
  const executable = requireExecutable(options);
  try {
    const stdout = childProcess.execFileSync(executable, buildArgs(args, options), {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", ...options.env },
    });
    return parseComfyCliEnvelope<T>(stdout, "");
  } catch (error) {
    const processError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const stdout = processError.stdout?.toString() ?? "";
    if (stdout) return parseComfyCliEnvelope<T>(stdout, processError.stderr?.toString() ?? "", processError.status);
    throw error;
  }
}

export function getComfyCliVersion(): string | null {
  const executable = resolveComfyCliExecutable();
  if (!executable) return null;
  const result = childProcess.spawnSync(executable, ["--json", "--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  try {
    return parseComfyCliEnvelope(result.stdout ?? "", result.stderr ?? "", result.status ?? undefined).version;
  } catch {
    return null;
  }
}

export function assertComfyCliOk<T>(envelope: ComfyCliEnvelope<T>): ComfyCliEnvelope<T> {
  if (!envelope.ok) {
    const error = envelope.error;
    throw new Error(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? "comfy-cli command failed"}${error?.hint ? ` (${error.hint})` : ""}`);
  }
  return envelope;
}
