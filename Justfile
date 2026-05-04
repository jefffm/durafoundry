set shell := ["bash", "-euo", "pipefail", "-c"]

[default]
list:
    @just --list

install:
    npm install

typecheck:
    npm run typecheck --workspaces --if-present

test:
    npm test --workspaces --if-present

audit:
    npm audit

ubs-diff:
    npm run ubs:diff

validate:
    npm run typecheck --workspaces --if-present
    npm test --workspaces --if-present
    npm audit
    npm run ubs:diff

# Start a local Temporal dev server, run the fixture CLI through Temporal, and stop it.
smoke-temporal-cli:
    #!/usr/bin/env bash
    set -euo pipefail

    address="127.0.0.1:7233"
    ui_port="8233"
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/durafoundry-temporal-smoke.XXXXXX")"
    log_path="$tmpdir/temporal.log"
    db_path="$tmpdir/temporal.db"
    server_pid=""

    cleanup() {
      if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
      fi
      rm -rf "$tmpdir"
    }
    trap cleanup EXIT

    temporal server start-dev \
      --ip 127.0.0.1 \
      --port 7233 \
      --ui-port "$ui_port" \
      --db-filename "$db_path" \
      --log-level warn \
      >"$log_path" 2>&1 &
    server_pid="$!"

    ready="false"
    for _ in {1..60}; do
      if ! kill -0 "$server_pid" 2>/dev/null; then
        echo "Temporal dev server exited before becoming ready" >&2
        cat "$log_path" >&2
        exit 1
      fi

      if temporal operator cluster health --address "$address" --namespace default >/dev/null 2>&1; then
        ready="true"
        break
      fi

      sleep 1
    done

    if [[ "$ready" != "true" ]]; then
      echo "Temporal dev server did not become ready at $address" >&2
      cat "$log_path" >&2
      exit 1
    fi

    temporal operator cluster health --address "$address" --namespace default
    temporal workflow list --address "$address" --namespace default --limit 1 >/dev/null

    npm run build --workspace @durafoundry/cli >/dev/null
    output="$(node apps/cli/dist/index.js run \
      --spec docs/SPEC.md \
      --fixture-repo \
      --artifact-root "$tmpdir/artifacts" \
      --temporal-address "$address" \
      --start-worker \
      --auto-approve)"
    status="$(jq -r '.finalStatus' <<<"$output")"
    if [[ "$status" != "completed" ]]; then
      echo "DuraFoundry CLI smoke run did not complete: $output" >&2
      exit 1
    fi
    echo "$output" | jq '{runId, temporalRunId, workflowId, taskQueue, temporalAddress, finalStatus}'
    echo "Temporal fixture CLI smoke test passed; UI was available on http://127.0.0.1:$ui_port while the test was running"

# Run a long-lived local Temporal dev server until Ctrl-C.
temporal-dev:
    mkdir -p .durafoundry
    temporal server start-dev \
      --ip 127.0.0.1 \
      --port 7233 \
      --ui-port 8233 \
      --db-filename .durafoundry/temporal-dev.db \
      --log-level warn
