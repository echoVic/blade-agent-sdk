import { TokenBudget, type TokenBudgetConfig } from '@blade-ai/agent/budget';
import type { AgentTokenBudgetPort } from '@blade-ai/agent/protocol';
import type { PackageLocalRuntimeResolvedAgentKernelCreationOptions } from './runtimeAgentKernels.js';

export interface PackageLocalRuntimeTokenBudgetOperations {
  apply<TOptions extends PackageLocalRuntimeResolvedAgentKernelCreationOptions>(
    options: TOptions,
  ): TOptions & { tokenBudget?: AgentTokenBudgetPort };
}

export function createPackageLocalRuntimeTokenBudgetOperations(
  config?: TokenBudgetConfig,
): PackageLocalRuntimeTokenBudgetOperations {
  const tokenBudget = config ? new TokenBudget(config) : undefined;

  return {
    apply<TOptions extends PackageLocalRuntimeResolvedAgentKernelCreationOptions>(
      options: TOptions,
    ): TOptions & { tokenBudget?: AgentTokenBudgetPort } {
      if (options.tokenBudget || !tokenBudget) {
        return options;
      }

      return {
        ...options,
        tokenBudget,
      };
    },
  };
}
