# DuraFoundry

Durable software factory orchestration built on Temporal and Flue.

DuraFoundry turns approved software specifications into structured execution DAGs, runs implementation nodes through controlled agent activities, gates changes through review and judgement, and merges accepted work through a durable queue.

## Documentation

- [Specification](docs/SPEC.md)
- [V0 execution plan](docs/execution-plan-v0.md)
- [Flue/Codex integration spike](docs/spikes/flue-codex-integration.md)

## Packages

- `apps/cli`: v0 local demo CLI. It runs against a generated disposable fixture
  repository and local artifact root, not this implementation checkout.
- `packages/flue-runtime`: reusable Flue runtime helpers for DuraFoundry agent
  Activities, including userland OpenAI Codex OAuth resolution and Flue
  `init({ providers })` wiring for `openai-codex`.

## CLI Demo

Run the v0 fixture demo from this repository:

```bash
npm run build --workspace @durafoundry/cli
node apps/cli/dist/index.js run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry
```

The CLI prints one JSON object with the run id, workflow id, artifact root,
generated fixture repository path, node commit SHAs, merge commit SHAs, and
final status. The `--fixture-repo` flag is required in v0 so the demo creates a
throwaway target under the artifact root instead of mutating this checkout.

## Quality Checks

- `npm run typecheck`
- `npm run test`
- `npm run ubs` for the repo UBS scan
- `npm run ubs:diff` for a quick modified-files scan
- `npm run ubs:strict` to fail on warnings/critical findings
- `npm run ubs:tests` to scan test files separately
- `npm run ubs:spike` to scan the live Flue/Codex spike separately

The earlier spec-only repository is retained as project history:

- https://github.com/jefffm/software-factory-orchestrator-spec

This repository is the implementation home.
