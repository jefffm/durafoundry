# Flue/Codex Spike

This package probes whether unmodified upstream Flue can run pi-ai's
`openai-codex` provider for DuraFoundry Activities.

Run:

```sh
npm install
npm run typecheck
npm run probe
```

This spike depends on the published `@flue/sdk` release that includes Flue PR
#29 provider overrides. PR #29 was merged on 2026-05-03, and `@flue/sdk@0.3.7`
or newer supports the required `init({ providers })` API.

Useful environment variables:

- `FLUE_BASELINE_MODEL`, default `openai/gpt-4.1`
- `FLUE_CODEX_MODEL`, default `openai-codex/gpt-5.3-codex`
- `OPENAI_API_KEY` or another provider-specific key for the baseline probe
- a Pi auth file at `~/.pi/agent/auth.json`; the spike refreshes and passes the
  access token through `init({ providers: { "openai-codex": { apiKey } } })`
- `FLUE_CODEX_PI_AUTH_FILE` to point at a non-default Pi auth file

The probe writes `REPORT.md` and `probe-report.json`. The JSON report is mode
`0600`; neither report includes token values.
