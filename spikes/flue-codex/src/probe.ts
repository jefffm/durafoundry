import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlueContext, InMemorySessionStore, resolveModel } from "@flue/sdk/internal";
import type { FlueEvent, ProvidersConfig, SessionEnv, ShellResult } from "@flue/sdk/client";
import { createSandboxSessionEnv } from "@flue/sdk/sandbox";
import type { SandboxApi } from "@flue/sdk/sandbox";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import * as v from "valibot";
import {
  BaselineTinyResultSchema,
  CodexTinyResultSchema,
  FlueModelProbeResultSchema,
  type FlueModelProbeResult,
} from "./schemas.js";

type ProbeReport = {
  generatedAt: string;
  versions: Record<string, string>;
  environment: {
    baselineModel: string;
    codexModel: string;
    baselineCredentialEnvPresent: boolean;
    codexEnvCredentialPresent: boolean;
    piAuthFilePresent: boolean;
    piAuthOpenAICodexEntryPresent: boolean;
    piAuthOpenAICodexAccessUsable: boolean;
  };
  probes: {
    baseline: FlueModelProbeResult;
    codexResolution: FlueModelProbeResult;
    codexAuth: FlueModelProbeResult;
    codexPromptResult?: FlueModelProbeResult;
    sessionCompaction?: FlueModelProbeResult;
  };
  decision: "supported" | "partially_supported" | "unsupported";
  upstreamFlueApiSurfaceRequired: string[];
  tokenLeakCheck: {
    checkedArtifacts: string[];
    findings: string[];
  };
};

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const reportPath = join(rootDir, "REPORT.md");
const reportJsonPath = join(rootDir, "probe-report.json");

const baselineModel = process.env.FLUE_BASELINE_MODEL ?? "openai/gpt-4.1";
const codexModel = process.env.FLUE_CODEX_MODEL ?? "openai-codex/gpt-5.3-codex";

const capturedEvents: FlueEvent[] = [];
const tokenCandidates = collectTokenCandidates();

main().catch(async (error) => {
  const fallback = makeResult(modelParts(codexModel), false, error);
  const report = await buildReport({
    baseline: makeResult(modelParts(baselineModel), false, error),
    codexResolution: fallback,
    codexAuth: fallback,
  });
  await writeReports(report);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const baseline = await runBaselineProbe();
  const codexResolution = runResolutionProbe(codexModel);
  const codexAuth = await runCodexAuthProbe();

  let codexPromptResult: FlueModelProbeResult | undefined;
  let sessionCompaction: FlueModelProbeResult | undefined;

  if (codexAuth.ok) {
    codexPromptResult = await runCodexPromptProbe();
  }

  if (codexPromptResult?.ok) {
    sessionCompaction = await runSessionCompactionProbe();
  }

  const report = await buildReport({
    baseline,
    codexResolution,
    codexAuth,
    codexPromptResult,
    sessionCompaction,
  });
  await writeReports(report);

  console.log(`Wrote ${relativePath(reportPath)} and ${relativePath(reportJsonPath)}`);
  console.log(`Decision: ${report.decision}`);
}

async function runBaselineProbe(): Promise<FlueModelProbeResult> {
  const parts = modelParts(baselineModel);
  const events: FlueEvent[] = [];

  try {
    const { agent, cleanup } = await createProbeAgent(baselineModel, events);
    try {
      const session = await agent.session("baseline");
      const result = await session.prompt(
        'Return only JSON matching this shape: {"status":"ok","message":"baseline-through-flue"}',
        {
          result: BaselineTinyResultSchema,
          timeout: 45,
        },
      );
      const resultExtractionOk = result.status === "ok";
      return finalizeResult(parts, {
        ok: true,
        resultExtractionOk,
        events,
      });
    } finally {
      await cleanup();
    }
  } catch (error) {
    return finalizeResult(parts, { ok: false, error, events });
  }
}

function runResolutionProbe(model: string): FlueModelProbeResult {
  const parts = modelParts(model);
  try {
    const resolved = resolveModel(model);
    if (!resolved) {
      throw new Error(`Model did not resolve: ${model}`);
    }
    return finalizeResult(parts, {
      ok: resolved.provider === parts.provider && resolved.id === parts.model,
      resultExtractionOk: false,
      events: [],
    });
  } catch (error) {
    return finalizeResult(parts, { ok: false, error, events: [] });
  }
}

async function runCodexAuthProbe(): Promise<FlueModelProbeResult> {
  const parts = modelParts(codexModel);
  const events: FlueEvent[] = [];
  const providers = await createCodexProvidersConfig();

  try {
    const { agent, cleanup } = await createProbeAgent(codexModel, events, {}, providers);
    try {
      const session = await agent.session("codex-auth");
      const response = await session.prompt("Reply with exactly: codex-auth-ok", { timeout: 45 });
      return finalizeResult(parts, {
        ok: response.text.includes("codex-auth-ok"),
        resultExtractionOk: false,
        events,
      });
    } finally {
      await cleanup();
    }
  } catch (error) {
    return finalizeResult(parts, { ok: false, error, events });
  }
}

async function runCodexPromptProbe(): Promise<FlueModelProbeResult> {
  const parts = modelParts(codexModel);
  const events: FlueEvent[] = [];
  const providers = await createCodexProvidersConfig();

  try {
    const { agent, cleanup } = await createProbeAgent(codexModel, events, {}, providers);
    try {
      const session = await agent.session("codex-prompt");
      const result = await session.prompt(
        'Return only JSON: {"status":"ok","message":"codex-through-flue"}',
        {
          result: CodexTinyResultSchema,
          timeout: 60,
        },
      );
      return finalizeResult(parts, {
        ok: result.status === "ok" && result.message === "codex-through-flue",
        resultExtractionOk: true,
        events,
      });
    } finally {
      await cleanup();
    }
  } catch (error) {
    return finalizeResult(parts, { ok: false, error, events });
  }
}

async function runSessionCompactionProbe(): Promise<FlueModelProbeResult> {
  const parts = modelParts(codexModel);
  const events: FlueEvent[] = [];
  const providers = await createCodexProvidersConfig();

  try {
    const { agent, cleanup } = await createProbeAgent(codexModel, events, {
      compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    }, providers);
    try {
      const first = await agent.session("stable-session");
      await first.prompt("Reply with exactly: first-ok", { timeout: 45 });
      const second = await agent.session("stable-session");
      await second.prompt("Reply with exactly: second-ok", { timeout: 45 });
      return finalizeResult(parts, {
        ok: first.id === second.id,
        resultExtractionOk: false,
        events,
        compactionObserved: events.some((event) => event.type === "compaction_start"),
      });
    } finally {
      await cleanup();
    }
  } catch (error) {
    return finalizeResult(parts, { ok: false, error, events });
  }
}

async function createProbeAgent(
  model: string,
  events: FlueEvent[],
  overrides: Partial<Parameters<typeof createFlueContext>[0]["agentConfig"]> = {},
  providers?: ProvidersConfig,
) {
  const envRoot = mkdtempSync(join(tmpdir(), "durafoundry-flue-codex-"));
  const makeEnv = () => Promise.resolve(createTempSessionEnv(envRoot));
  const ctx = createFlueContext({
    id: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    payload: {},
    env: {},
    agentConfig: {
      systemPrompt: "You are a terse probe agent. Follow output format instructions exactly.",
      skills: {},
      roles: {},
      model: undefined,
      resolveModel,
      compaction: { enabled: false },
      ...overrides,
    },
    createDefaultEnv: makeEnv,
    createLocalEnv: makeEnv,
    defaultStore: new InMemorySessionStore(),
  });

  ctx.setEventCallback((event) => {
    events.push(event);
    capturedEvents.push(event);
  });

  const agent = await ctx.init({ model, sandbox: "empty", providers });
  return {
    agent,
    cleanup: async () => {
      await agent.destroy();
      rmSync(envRoot, { recursive: true, force: true });
    },
  };
}

function createTempSessionEnv(root: string): SessionEnv {
  const api: SandboxApi = {
    async readFile(path) {
      return readFile(toHostPath(root, path), "utf8");
    },
    async readFileBuffer(path) {
      return readFile(toHostPath(root, path));
    },
    async writeFile(path, content) {
      const hostPath = toHostPath(root, path);
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, content);
    },
    async stat(path) {
      const s = await stat(toHostPath(root, path));
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      };
    },
    async readdir(path) {
      return readdir(toHostPath(root, path));
    },
    async exists(path) {
      return existsSync(toHostPath(root, path));
    },
    async mkdir(path, options) {
      await mkdir(toHostPath(root, path), options);
    },
    async rm(path, options) {
      await rm(toHostPath(root, path), options);
    },
    async exec(command, options): Promise<ShellResult> {
      return {
        stdout: "",
        stderr: `Command execution disabled in spike sandbox: ${command}`,
        exitCode: 126,
      };
    },
  };

  return createSandboxSessionEnv(api, "/workspace");
}

function toHostPath(root: string, sandboxPath: string): string {
  const clean = sandboxPath.replace(/^\/+/, "");
  const hostPath = resolve(root, clean);
  if (!hostPath.startsWith(root)) {
    throw new Error(`Path escapes spike sandbox: ${sandboxPath}`);
  }
  return hostPath;
}

async function buildReport(probes: ProbeReport["probes"]): Promise<ProbeReport> {
  const tokenLeakFindings = scanForTokenLeaks([
    JSON.stringify(capturedEvents),
    reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "",
    reportJsonPath && existsSync(reportJsonPath) ? readFileSync(reportJsonPath, "utf8") : "",
  ]);

  const codexPromptOk = probes.codexPromptResult?.ok ?? false;
  const compactionOk = probes.sessionCompaction?.ok ?? false;
  const decision =
    codexPromptOk && compactionOk
      ? "supported"
      : probes.codexResolution.ok || probes.codexAuth.ok
        ? "partially_supported"
        : "unsupported";

  const upstreamFlueApiSurfaceRequired = codexPromptOk
    ? [
        "Provider session affinity is still not exposed by AgentInit/PromptOptions; only Flue session IDs are stable.",
      ]
    : [
        "AgentInit or agent configuration hook for pi-agent-core AgentOptions.getApiKey(provider).",
        "AgentInit or agent configuration hook for pi-agent-core streamFn/transport so applications can use a server-managed OAuth proxy like Vellum.",
        "Provider sessionId forwarding for openai-codex session affinity.",
      ];

  return {
    generatedAt: new Date().toISOString(),
    versions: collectVersions(),
    environment: await collectEnvironmentFacts(),
    probes,
    decision,
    upstreamFlueApiSurfaceRequired,
    tokenLeakCheck: {
      checkedArtifacts: ["captured Flue events", relativePath(reportPath), relativePath(reportJsonPath)],
      findings: tokenLeakFindings,
    },
  };
}

async function writeReports(report: ProbeReport): Promise<void> {
  const validated = {
    ...report,
    probes: {
      ...report.probes,
      baseline: v.parse(FlueModelProbeResultSchema, report.probes.baseline),
      codexResolution: v.parse(FlueModelProbeResultSchema, report.probes.codexResolution),
      codexAuth: v.parse(FlueModelProbeResultSchema, report.probes.codexAuth),
      codexPromptResult: report.probes.codexPromptResult
        ? v.parse(FlueModelProbeResultSchema, report.probes.codexPromptResult)
        : undefined,
      sessionCompaction: report.probes.sessionCompaction
        ? v.parse(FlueModelProbeResultSchema, report.probes.sessionCompaction)
        : undefined,
    },
  };

  await writeFile(reportJsonPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportJsonPath, 0o600);
  await writeFile(reportPath, renderMarkdownReport(validated));
}

function renderMarkdownReport(report: ProbeReport): string {
  const lines = [
    "# Flue/Codex Integration Spike Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `Result: \`${report.decision}\``,
    "",
    "## Versions",
    "",
    ...Object.entries(report.versions).map(([name, version]) => `- ${name}: \`${version}\``),
    "",
    "## Environment",
    "",
    `- Baseline model: \`${report.environment.baselineModel}\``,
    `- Codex model: \`${report.environment.codexModel}\``,
    `- Baseline credential env present: \`${report.environment.baselineCredentialEnvPresent}\``,
    `- Codex credential env present: \`${report.environment.codexEnvCredentialPresent}\``,
    `- Pi auth file present: \`${report.environment.piAuthFilePresent}\``,
    `- Pi auth openai-codex entry present: \`${report.environment.piAuthOpenAICodexEntryPresent}\``,
    `- Pi auth openai-codex access usable: \`${report.environment.piAuthOpenAICodexAccessUsable}\``,
    "",
    "## Probe Results",
    "",
    renderProbe("Baseline Flue Model Probe", report.probes.baseline),
    renderProbe("Codex Model Resolution Probe", report.probes.codexResolution),
    renderProbe("Codex Auth Probe", report.probes.codexAuth),
    report.probes.codexPromptResult
      ? renderProbe("Codex Prompt/Result Probe", report.probes.codexPromptResult)
      : "### Codex Prompt/Result Probe\n\nSkipped because Codex auth did not pass.\n",
    report.probes.sessionCompaction
      ? renderProbe("Session and Compaction Probe", report.probes.sessionCompaction)
      : "### Session and Compaction Probe\n\nSkipped because Codex prompt/result did not pass.\n",
    "## Minimum Upstream Flue API Surface Required",
    "",
    ...report.upstreamFlueApiSurfaceRequired.map((item) => `- ${item}`),
    "",
    "## Credential Redaction",
    "",
    `- Checked artifacts: ${report.tokenLeakCheck.checkedArtifacts.map((item) => `\`${item}\``).join(", ")}`,
    `- Findings: ${
      report.tokenLeakCheck.findings.length > 0
        ? report.tokenLeakCheck.findings.map((finding) => `\`${finding}\``).join(", ")
        : "`none`"
    }`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderProbe(title: string, result: FlueModelProbeResult): string {
  return [
    `### ${title}`,
    "",
    `- Provider: \`${result.provider}\``,
    `- Model: \`${result.model}\``,
    `- OK: \`${result.ok}\``,
    `- Result extraction OK: \`${result.resultExtractionOk}\``,
    `- Event stream observed: \`${result.eventStreamObserved}\``,
    `- Compaction observed: \`${result.compactionObserved ?? false}\``,
    result.errorClass ? `- Error class: \`${result.errorClass}\`` : undefined,
    result.errorMessage ? `- Error message: \`${sanitize(result.errorMessage)}\`` : undefined,
    `- Redaction findings: ${
      result.redactionFindings.length > 0
        ? result.redactionFindings.map((finding) => `\`${finding}\``).join(", ")
        : "`none`"
    }`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function finalizeResult(
  parts: { provider: string; model: string },
  input: {
    ok: boolean;
    resultExtractionOk?: boolean;
    events: FlueEvent[];
    error?: unknown;
    compactionObserved?: boolean;
  },
): FlueModelProbeResult {
  const errorInfo: Partial<Pick<FlueModelProbeResult, "errorClass" | "errorMessage">> = input.error
    ? classifyError(input.error)
    : {};
  return {
    provider: parts.provider,
    model: parts.model,
    ok: input.ok,
    resultExtractionOk: input.resultExtractionOk ?? false,
    eventStreamObserved: input.events.length > 0,
    compactionObserved:
      input.compactionObserved ?? input.events.some((event) => event.type === "compaction_start"),
    ...errorInfo,
    redactionFindings: scanForTokenLeaks([JSON.stringify(input.events), errorInfo.errorMessage ?? ""]),
  };
}

function makeResult(
  parts: { provider: string; model: string },
  ok: boolean,
  error?: unknown,
): FlueModelProbeResult {
  return finalizeResult(parts, { ok, error, events: [] });
}

function modelParts(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash === -1) {
    return { provider: "", model };
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

function classifyError(error: unknown): { errorClass: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorClass: error.name || "Error", errorMessage: sanitize(error.message) };
  }
  return { errorClass: typeof error, errorMessage: sanitize(String(error)) };
}

function sanitize(text: string): string {
  let sanitized = text;
  for (const token of tokenCandidates) {
    sanitized = sanitized.split(token).join("[REDACTED]");
  }
  return sanitized;
}

function scanForTokenLeaks(values: string[]): string[] {
  const findings: string[] = [];
  for (const token of tokenCandidates) {
    if (token.length < 12) continue;
    values.forEach((value, index) => {
      if (value.includes(token)) {
        findings.push(`token candidate leaked in artifact ${index}`);
      }
    });
  }
  return [...new Set(findings)];
}

function collectTokenCandidates(): string[] {
  const candidates = [
    process.env.OPENAI_CODEX_API_KEY,
    process.env.VELLUM_LLM_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const authFile = resolvePiAuthFile();
  if (existsSync(authFile)) {
    try {
      const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
      const codex = auth["openai-codex"];
      if (isRecord(codex)) {
        for (const key of ["access", "refresh"]) {
          const value = codex[key];
          if (typeof value === "string" && value.length > 0) {
            candidates.push(value);
          }
        }
      }
    } catch {
      // Ignore malformed local auth when building redaction candidates.
    }
  }

  return candidates;
}

async function createCodexProvidersConfig(): Promise<ProvidersConfig | undefined> {
  const apiKey = await resolveOpenAICodexApiKeyFromPiAuth();
  if (!apiKey) {
    return undefined;
  }

  return {
    "openai-codex": {
      apiKey,
    },
  };
}

async function collectEnvironmentFacts(): Promise<ProbeReport["environment"]> {
  const piAuthFile = resolvePiAuthFile();
  const piAuthFilePresent = existsSync(piAuthFile);
  let piAuthOpenAICodexEntryPresent = false;

  if (piAuthFilePresent) {
    try {
      const auth = JSON.parse(readFileSync(piAuthFile, "utf8")) as Record<string, unknown>;
      piAuthOpenAICodexEntryPresent = isRecord(auth["openai-codex"]);
    } catch {
      piAuthOpenAICodexEntryPresent = false;
    }
  }

  const piAuthAccess = await resolveOpenAICodexApiKeyFromPiAuth();

  return {
    baselineModel,
    codexModel,
    baselineCredentialEnvPresent: providerCredentialEnvPresent(modelParts(baselineModel).provider),
    codexEnvCredentialPresent: providerCredentialEnvPresent("openai-codex"),
    piAuthFilePresent,
    piAuthOpenAICodexEntryPresent,
    piAuthOpenAICodexAccessUsable: typeof piAuthAccess === "string" && piAuthAccess.length > 0,
  };
}

function providerCredentialEnvPresent(provider: string): boolean {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return Boolean(
    process.env[`${normalized}_API_KEY`] ||
      (provider === "openai" && process.env.OPENAI_API_KEY) ||
      (provider === "anthropic" && process.env.ANTHROPIC_API_KEY),
  );
}

async function resolveOpenAICodexApiKeyFromPiAuth(): Promise<string | undefined> {
  const authFile = resolvePiAuthFile();
  if (!existsSync(authFile)) {
    return undefined;
  }

  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    const entry = parseOAuthEntry(auth["openai-codex"]);
    if (!entry) return undefined;

    if (entry.expires > Date.now() + 60_000) {
      return entry.access;
    }

    const { refreshOpenAICodexToken } = await import("@mariozechner/pi-ai/oauth");
    const refreshed = await refreshOpenAICodexToken(entry.refresh);
    const refreshedEntry = parseOAuthEntry({ ...entry, ...refreshed, type: "oauth" });
    if (!refreshedEntry) return undefined;

    auth["openai-codex"] = { ...entry, ...refreshed, type: "oauth" };
    await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await chmod(authFile, 0o600);

    tokenCandidates.push(refreshedEntry.access, refreshedEntry.refresh);
    return refreshedEntry.access;
  } catch {
    return undefined;
  }
}

function resolvePiAuthFile(): string {
  if (process.env.FLUE_CODEX_PI_AUTH_FILE) {
    return process.env.FLUE_CODEX_PI_AUTH_FILE;
  }
  if (process.env.VELLUM_PI_AUTH_FILE) {
    return process.env.VELLUM_PI_AUTH_FILE;
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  }
  return join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
}

function parseOAuthEntry(value: unknown): OAuthCredentials | undefined {
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
  return value as OAuthCredentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectVersions(): Record<string, string> {
  return {
    node: process.version,
    packageManager: packageManagerVersion(),
    "@flue/sdk": packageVersion("@flue/sdk"),
    "@mariozechner/pi-ai": packageVersion("@mariozechner/pi-ai"),
    "@mariozechner/pi-agent-core": packageVersion("@mariozechner/pi-agent-core"),
    typescript: packageVersion("typescript"),
  };
}

function packageManagerVersion(): string {
  try {
    return `npm ${execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()}`;
  } catch {
    return "unknown";
  }
}

function packageVersion(packageName: string): string {
  try {
    const packageJsonPath = findPackageJson(requireResolve(packageName));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function requireResolve(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function findPackageJson(fromPath: string): string {
  let dir = dirname(fromPath);
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not find package.json above ${fromPath}`);
}

function relativePath(path: string): string {
  return path.replace(`${process.cwd()}/`, "");
}
