# Flue/Codex Integration Spike Report

Generated: 2026-05-03T09:31:23.343Z

## Decision

Result: `supported`

## Versions

- node: `v25.9.0`
- packageManager: `npm 11.6.2`
- @flue/sdk: `0.3.9`
- @mariozechner/pi-ai: `0.66.1`
- @mariozechner/pi-agent-core: `0.72.1`
- typescript: `5.9.3`

## Environment

- Baseline model: `openai/gpt-4.1`
- Codex model: `openai-codex/gpt-5.3-codex`
- Baseline credential env present: `false`
- Codex credential env present: `false`
- Pi auth file present: `true`
- Pi auth openai-codex entry present: `true`
- Pi auth openai-codex access usable: `true`

## Probe Results

### Baseline Flue Model Probe

- Provider: `openai`
- Model: `gpt-4.1`
- OK: `false`
- Result extraction OK: `false`
- Event stream observed: `true`
- Compaction observed: `false`
- Error class: `Error`
- Error message: `[flue] prompt failed: No API key for provider: openai`
- Redaction findings: `none`

### Codex Model Resolution Probe

- Provider: `openai-codex`
- Model: `gpt-5.3-codex`
- OK: `true`
- Result extraction OK: `false`
- Event stream observed: `false`
- Compaction observed: `false`
- Redaction findings: `none`

### Codex Auth Probe

- Provider: `openai-codex`
- Model: `gpt-5.3-codex`
- OK: `true`
- Result extraction OK: `false`
- Event stream observed: `true`
- Compaction observed: `false`
- Redaction findings: `none`

### Codex Prompt/Result Probe

- Provider: `openai-codex`
- Model: `gpt-5.3-codex`
- OK: `true`
- Result extraction OK: `true`
- Event stream observed: `true`
- Compaction observed: `false`
- Redaction findings: `none`

### Session and Compaction Probe

- Provider: `openai-codex`
- Model: `gpt-5.3-codex`
- OK: `true`
- Result extraction OK: `false`
- Event stream observed: `true`
- Compaction observed: `false`
- Redaction findings: `none`

## Minimum Upstream Flue API Surface Required

- Provider session affinity is still not exposed by AgentInit/PromptOptions; only Flue session IDs are stable.

## Credential Redaction

- Checked artifacts: `captured Flue events`, `REPORT.md`, `probe-report.json`
- Findings: `none`

