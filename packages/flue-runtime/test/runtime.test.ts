import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInit, FlueAgent, FlueContext } from "@flue/sdk/client";
import { createFlueAgentRuntime } from "../src/runtime.ts";

test("initCodexAgent injects provider apiKey without exposing token elsewhere", async () => {
  let capturedInit: AgentInit | undefined;
  const context = {
    id: "ctx",
    payload: {},
    env: {},
    init: async (options?: AgentInit) => {
      capturedInit = options;
      return { id: "agent" } as FlueAgent;
    },
  } satisfies FlueContext;

  const runtime = createFlueAgentRuntime({
    context,
    codexAuth: {
      authFile: "/tmp/auth.json",
      now: () => 1_000,
      readAuthFile: async () =>
        JSON.stringify({
          "openai-codex": {
            access: "codex-access",
            refresh: "codex-refresh",
            expires: 120_000,
          },
        }),
    },
  });

  const agent = await runtime.initCodexAgent({
    model: "openai-codex/gpt-5.3-codex",
    providers: {
      anthropic: { apiKey: "anthropic-token" },
    },
  });

  assert.equal(agent.id, "agent");
  assert.equal(capturedInit?.model, "openai-codex/gpt-5.3-codex");
  assert.deepEqual(capturedInit?.providers, {
    anthropic: { apiKey: "anthropic-token" },
    "openai-codex": { apiKey: "codex-access" },
  });
});
