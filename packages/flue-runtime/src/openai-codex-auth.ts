import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProvidersConfig } from "@flue/sdk/client";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export type PiAuthFile = Record<string, unknown>;

export type PiOAuthEntry = {
  type?: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
};

export type CodexAuthResolverOptions = {
  authFile?: string;
  now?: () => number;
  refreshWindowMs?: number;
  readAuthFile?: (path: string) => Promise<string>;
  writeAuthFile?: (path: string, content: string) => Promise<void>;
  refreshOpenAICodexToken?: (refreshToken: string) => Promise<OAuthCredentials>;
};

export class CodexCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCredentialError";
  }
}

export function defaultPiAuthPath(): string {
  if (process.env.DURAFOUNDRY_PI_AUTH_FILE) return process.env.DURAFOUNDRY_PI_AUTH_FILE;
  if (process.env.VELLUM_PI_AUTH_FILE) return process.env.VELLUM_PI_AUTH_FILE;
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  return join(homedir(), ".pi", "agent", "auth.json");
}

export async function resolveOpenAICodexAccessToken(
  options: CodexAuthResolverOptions = {},
): Promise<string> {
  const authFile = options.authFile ?? defaultPiAuthPath();
  const auth = await readPiAuthFile(authFile, options);
  const entry = parseOAuthEntry(auth[OPENAI_CODEX_PROVIDER]);

  if (!entry) {
    throw new CodexCredentialError(
      `No usable ${OPENAI_CODEX_PROVIDER} OAuth credentials found in ${authFile}`,
    );
  }

  const now = options.now?.() ?? Date.now();
  const refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;

  if (entry.expires > now + refreshWindowMs) {
    return entry.access;
  }

  const refreshToken = options.refreshOpenAICodexToken ?? loadOpenAICodexRefreshToken;
  const refreshed = await refreshToken(entry.refresh);
  const refreshedEntry = parseOAuthEntry({ ...entry, ...refreshed, type: "oauth" });

  if (!refreshedEntry) {
    throw new CodexCredentialError(`${OPENAI_CODEX_PROVIDER} token refresh returned invalid credentials`);
  }

  auth[OPENAI_CODEX_PROVIDER] = { ...entry, ...refreshed, type: "oauth" };
  await writePiAuthFile(authFile, auth, options);

  return refreshedEntry.access;
}

export async function createCodexProvidersConfig(
  options: CodexAuthResolverOptions = {},
): Promise<ProvidersConfig> {
  return {
    [OPENAI_CODEX_PROVIDER]: {
      apiKey: await resolveOpenAICodexAccessToken(options),
    },
  };
}

async function readPiAuthFile(
  authFile: string,
  options: CodexAuthResolverOptions,
): Promise<PiAuthFile> {
  try {
    const raw = options.readAuthFile ? await options.readAuthFile(authFile) : await readFile(authFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new CodexCredentialError(`Pi auth file is not a JSON object: ${authFile}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CodexCredentialError) throw error;
    throw new CodexCredentialError(`Could not read Pi auth file: ${authFile}`);
  }
}

async function writePiAuthFile(
  authFile: string,
  auth: PiAuthFile,
  options: CodexAuthResolverOptions,
): Promise<void> {
  const content = `${JSON.stringify(auth, null, 2)}\n`;

  if (options.writeAuthFile) {
    await options.writeAuthFile(authFile, content);
    return;
  }

  await writeFile(authFile, content, { mode: 0o600 });
  await chmod(authFile, 0o600);
}

function parseOAuthEntry(value: unknown): PiOAuthEntry | undefined {
  if (!isRecord(value)) return undefined;
  if ("type" in value && value.type !== undefined && value.type !== "oauth") return undefined;
  if (
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    typeof value.refresh !== "string" ||
    value.refresh.length === 0 ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires)
  ) {
    return undefined;
  }
  return value as PiOAuthEntry;
}

async function loadOpenAICodexRefreshToken(refreshToken: string): Promise<OAuthCredentials> {
  const { refreshOpenAICodexToken } = await import("@mariozechner/pi-ai/oauth");
  return refreshOpenAICodexToken(refreshToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
