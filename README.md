# DuraFoundry

Durable software factory orchestration built on Temporal and Flue.

DuraFoundry turns approved software specifications into structured execution DAGs, runs implementation nodes through controlled agent activities, gates changes through review and judgement, and merges accepted work through a durable queue.

## Documentation

- [Specification](docs/SPEC.md)
- [V0 execution plan](docs/execution-plan-v0.md)
- [Temporal V0 execution plan](docs/execution-plan-temporal-v0.md)
- [V0 hardening review](docs/v0-hardening-review.md)
- [Flue/Codex integration spike](docs/spikes/flue-codex-integration.md)

## Packages

- `apps/cli`: v0 local demo CLI. It runs against a generated disposable fixture
  repository and local artifact root, not this implementation checkout.
- `packages/flue-runtime`: reusable Flue runtime helpers for DuraFoundry agent
  Activities, including userland OpenAI Codex OAuth resolution and Flue
  `init({ providers })` wiring for `openai-codex`.

## CLI Demo

Run the v0 fixture demo from this repository against a local Temporal Server.
In one shell:

```bash
nix develop
just temporal-dev
```

In a second shell:

```bash
nix develop
npm run build --workspace @durafoundry/cli
node apps/cli/dist/index.js run \
  --spec docs/SPEC.md \
  --fixture-repo \
  --artifact-root .durafoundry \
  --start-worker \
  --auto-approve \
  --preserve-fixture
```

The CLI uses Temporal SDK Client and Worker APIs; it does not fall back to the
deterministic scaffold when Temporal is unavailable. `--temporal-address`
defaults to `TEMPORAL_ADDRESS` or `localhost:7233`, and `--task-queue` can be
provided to target an existing Worker. `--start-worker` starts the fixture
Worker in the CLI process for the local v0 demo. `--auto-approve` submits the
plan approval through a Temporal Update.

The CLI prints one JSON object with the DuraFoundry run id, Temporal run id,
workflow id, task queue, Temporal address, artifact root, generated fixture
repository path, plan id, DAG id, snapshot id, node commit SHAs, merge commit
SHAs, and final status. The `--fixture-repo` flag is required in v0 so the demo
creates a throwaway target under the artifact root instead of mutating this
checkout.

The acceptance coverage for this path is:

```bash
npm test --workspace @durafoundry/cli -- --test-name-pattern "temporal|acceptance|fixture"
```

That test uses a real Temporal test server, starts a fixture Worker, samples
workflow Query state, submits approval through an Update, asserts repair,
serial merge, milestone gates, cleanup, artifact contents, and validates the
final CLI JSON shape.

## Development Shell

The canonical development environment is the pinned Nix flake:

```bash
nix develop
just --list
```

The shell provides Node.js, npm, `just`, `temporal`, `jq`, `git`, and `rg`.
Use `direnv allow` if you want `.envrc` to enter the shell automatically.

Useful recipes:

```bash
just validate
just smoke-temporal-cli
just temporal-dev
```

`just smoke-temporal-cli` starts an isolated local Temporal dev server with
`temporal server start-dev`, waits until it is healthy, runs the fixture CLI
through Temporal, and then shuts the server down. `just temporal-dev` starts a
long-running local Temporal dev server at `127.0.0.1:7233` with the UI at
`http://127.0.0.1:8233`.

## Quality Checks

- `npm run typecheck`
- `npm run test`
- `npm run ubs` for the repo UBS scan
- `npm run ubs:diff` for a quick modified-files scan
- `npm run ubs:strict` to fail on warnings/critical findings
- `npm run ubs:tests` to scan test files separately
- `npm run ubs:spike` to scan the live Flue/Codex spike separately
