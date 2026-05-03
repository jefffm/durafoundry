# Flue/Codex Integration Spike

Status: completed  
Owner: Jeff  
Related spec sections: `docs/SPEC.md` sections 7.1.1 and 22

## Result

Outcome: Supported through Flue provider overrides.

The spike initially confirmed that unmodified `@flue/sdk@0.3.6` could resolve
`openai-codex/gpt-5.3-codex` but could not pass the Pi OAuth access token to
pi-agent-core. Flue PR #29 added provider runtime settings via `init({
providers })` and was released in `@flue/sdk@0.3.7`; the spike now passes with
published `@flue/sdk@0.3.9`.

DuraFoundry should not depend on Flue handling user OAuth. Instead,
`packages/flue-runtime` reads and refreshes local Pi auth in userland, then
passes only the current access token to Flue:

```ts
await init({
  model: "openai-codex/gpt-5.3-codex",
  providers: {
    "openai-codex": { apiKey: accessToken },
  },
});
```

Latest local spike report: `spikes/flue-codex/REPORT.md`.

## Purpose

Determine whether unmodified upstream Flue can run subscription-backed Codex models through pi-ai's `openai-codex` provider well enough for DuraFoundry agent Activities.

The spike must not add a command-line Codex adapter, shell-based agent runtime, or orchestrator-specific Flue fork. If Codex cannot work through existing upstream Flue, DuraFoundry keeps Codex subscription support disabled until upstream Flue exposes the required provider hooks.

## Background

DuraFoundry's durable orchestration is Temporal-first. Flue is the only agent runtime boundary. Codex subscription support is desirable because pi-ai ships an `openai-codex` provider, but current Flue source review found a likely gap: Flue constructs pi-agent-core `Agent` instances without exposing all provider options needed by the Codex provider.

The source review found these relevant facts:

- pi-ai has an `openai-codex` provider backed by `openai-codex-responses`.
- The provider expects an OAuth access token as the provider API key.
- pi-agent-core supports `AgentOptions.getApiKey(provider)`, `sessionId`, and provider `transport`.
- Current Flue `AgentInit` does not expose `getApiKey`, provider `sessionId`, or provider `transport`.
- Current Flue compaction does not obviously use a Flue-level credential hook.

The spike exists to verify this against the actual dependency version used by DuraFoundry, not to design around assumptions.

## Constraints

1. Use unmodified upstream Flue.
2. Do not use the Codex CLI.
3. Do not add a generic command-line agent harness.
4. Do not place OAuth access or refresh tokens in prompts, transcripts, Temporal history, memo, search attributes, logs, or committed files.
5. Keep the spike either reusable through a clean production seam or small enough to delete and rewrite.

## Recommended Shape

Create a tiny standalone spike package:

```text
spikes/flue-codex/
  README.md
  package.json
  src/
    probe.ts
    schemas.ts
```

This is intentionally outside `apps/worker` and `packages/` at first. The spike can be deleted without affecting the product code. If it succeeds, move only the reusable parts into the real implementation.

Reusable parts to preserve if successful:

- `FlueModelProbeResult` schema
- model/provider capability checks
- event capture shape
- result extraction repair strategy, if needed
- credential redaction checks

Do not preserve the spike's one-off process wiring, ad hoc environment loading, or sample prompts.

## Probe Cases

The spike should run these cases in order.

### 1. Baseline Flue Model Probe

Goal: prove the DuraFoundry process can initialize Flue and call a known working model/provider supported by existing Flue.

Required output:

```ts
interface FlueModelProbeResult {
  provider: string;
  model: string;
  ok: boolean;
  resultExtractionOk: boolean;
  eventStreamObserved: boolean;
  compactionObserved?: boolean;
  errorClass?: string;
  errorMessage?: string;
  redactionFindings: string[];
}
```

This case prevents confusing general Flue setup failures with Codex-provider failures.

### 2. Codex Model Resolution Probe

Goal: prove Flue can resolve `openai-codex/*` model strings through pi-ai.

This does not need to complete a model call. It should fail clearly if the model string cannot be resolved by the installed Flue/pi-ai dependency graph.

### 3. Codex Auth Probe

Goal: determine whether unmodified Flue has any supported path to provide an OAuth access token to pi-agent-core for provider `openai-codex`.

Expected result based on current source review: likely blocked.

Allowed credential sources:

- local developer credential store read by the spike process
- environment variable containing a short-lived access token, only for the local spike

Disallowed:

- writing token values into prompts
- committing token fixtures
- adding a CLI Codex fallback
- monkey-patching Flue internals

### 4. Codex Prompt/Result Probe

Goal: if auth works, run one minimal typed-result Flue prompt against `openai-codex/*`.

The prompt should ask for a tiny JSON result, for example:

```ts
{
  "status": "ok",
  "message": "codex-through-flue"
}
```

Acceptance requires:

- schema-validated result extraction
- captured Flue events
- no token leakage in captured transcript/artifacts/logs
- clean cancellation behavior if the process is interrupted

### 5. Session and Compaction Probe

Goal: if prompt/result works, verify whether provider session affinity and compaction are usable.

Acceptance requires:

- stable Flue session IDs across two prompts
- evidence of whether provider `sessionId` is actually forwarded to pi-agent-core
- compaction either works with Codex credentials or is explicitly reported unsupported

## Decision Outcomes

### Outcome A: Supported

Unmodified Flue can run Codex through pi-ai with OAuth credentials, typed result extraction, event streaming, cancellation, and compaction.

Next action:

- Add a production `FlueAgentRuntime` abstraction in the implementation.
- Keep the spike package as a regression tool or migrate the probe into integration tests.
- Enable Codex as an optional configured model provider.

### Outcome B: Partially Supported

Unmodified Flue can resolve or partially call Codex, but cannot satisfy one or more required capabilities.

Next action:

- Keep Codex disabled in DuraFoundry.
- Open or draft an upstream Flue issue/PR proposal describing the exact missing surface.
- Continue DuraFoundry implementation with another existing-Flue-compatible model/provider path.

### Outcome C: Unsupported

Unmodified Flue cannot call Codex subscription models without private patches or CLI fallback.

Next action:

- Delete the spike package after preserving its findings in this document or a follow-up ADR.
- Keep Codex disabled.
- Do not revisit until upstream Flue changes.

## Definition of Done

The spike is complete when it produces a committed report with:

1. Exact Flue, pi-ai, pi-agent-core, Node, and package-manager versions.
2. The result of each probe case.
3. Whether Codex is `supported`, `partially_supported`, or `unsupported`.
4. The minimum upstream Flue API surface required if blocked.
5. Confirmation that no OAuth token values were written to prompts, transcripts, logs, artifacts, Git history, or Temporal state.

## Non-Goals

- Building the DuraFoundry Temporal worker.
- Designing all agent role prompts.
- Supporting the Codex CLI.
- Building a custom Flue fork.
- Building a generic model-provider abstraction before the first Temporal slice works.
