import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CodexCredentialError,
  createCodexProvidersConfig,
  defaultPiAuthPath,
  resolveOpenAICodexAccessToken,
} from "../src/openai-codex-auth.ts";

test("defaultPiAuthPath honors explicit overrides", () => {
  const previous = process.env.DURAFOUNDRY_PI_AUTH_FILE;
  process.env.DURAFOUNDRY_PI_AUTH_FILE = "/tmp/custom-auth.json";
  try {
    assert.equal(defaultPiAuthPath(), "/tmp/custom-auth.json");
  } finally {
    if (previous === undefined) delete process.env.DURAFOUNDRY_PI_AUTH_FILE;
    else process.env.DURAFOUNDRY_PI_AUTH_FILE = previous;
  }
});

test("resolveOpenAICodexAccessToken returns current access token", async () => {
  const token = await resolveOpenAICodexAccessToken({
    authFile: "/tmp/auth.json",
    now: () => 1_000,
    readAuthFile: async () =>
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "current-access",
          refresh: "current-refresh",
          expires: 120_000,
        },
      }),
  });

  assert.equal(token, "current-access");
});

test("resolveOpenAICodexAccessToken refreshes expired token and persists auth", async () => {
  let persisted = "";
  const token = await resolveOpenAICodexAccessToken({
    authFile: "/tmp/auth.json",
    now: () => 100_000,
    readAuthFile: async () =>
      JSON.stringify({
        untouched: true,
        "openai-codex": {
          type: "oauth",
          access: "old-access",
          refresh: "old-refresh",
          expires: 100_001,
        },
      }),
    writeAuthFile: async (_path, content) => {
      persisted = content;
    },
    refreshOpenAICodexToken: async (refreshToken) => {
      assert.equal(refreshToken, "old-refresh");
      return {
        access: "new-access",
        refresh: "new-refresh",
        expires: 500_000,
      };
    },
  });

  assert.equal(token, "new-access");
  const parsed = JSON.parse(persisted);
  assert.equal(parsed.untouched, true);
  assert.equal(parsed["openai-codex"].access, "new-access");
  assert.equal(parsed["openai-codex"].refresh, "new-refresh");
});

test("createCodexProvidersConfig returns Flue provider apiKey override", async () => {
  const providers = await createCodexProvidersConfig({
    authFile: "/tmp/auth.json",
    now: () => 1_000,
    readAuthFile: async () =>
      JSON.stringify({
        "openai-codex": {
          access: "provider-token",
          refresh: "refresh-token",
          expires: 120_000,
        },
      }),
  });

  assert.deepEqual(providers, {
    "openai-codex": {
      apiKey: "provider-token",
    },
  });
});

test("resolveOpenAICodexAccessToken rejects missing credentials", async () => {
  await assert.rejects(
    resolveOpenAICodexAccessToken({
      authFile: "/tmp/auth.json",
      readAuthFile: async () => JSON.stringify({}),
    }),
    CodexCredentialError,
  );
});
