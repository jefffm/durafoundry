import type { FlueContext, FlueAgent, AgentInit } from "@flue/sdk/client";
import { createCodexProvidersConfig, type CodexAuthResolverOptions } from "./openai-codex-auth.js";

export type FlueAgentRuntimeOptions = {
  context: FlueContext;
  codexAuth?: CodexAuthResolverOptions;
};

export type FlueAgentRuntime = {
  initCodexAgent(options: AgentInit): Promise<FlueAgent>;
};

export function createFlueAgentRuntime(options: FlueAgentRuntimeOptions): FlueAgentRuntime {
  return {
    async initCodexAgent(initOptions) {
      const codexProviders = await createCodexProvidersConfig(options.codexAuth);
      return options.context.init({
        ...initOptions,
        providers: {
          ...initOptions.providers,
          ...codexProviders,
        },
      });
    },
  };
}
