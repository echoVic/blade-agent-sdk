const agentPublicTypeImportContracts = {
  localDeclaration: [
    "import type { AgentKernelOptions } from '@blade-ai/agent/kernel';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentStreamEvent } from '@blade-ai/agent/protocol';",
    "import type { AgentToolCall } from '@blade-ai/agent/protocol';",
    "import type { AgentTraceEvent } from '@blade-ai/agent/tracing';",
  ],
  packedConsumer: [
    "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    "import type { AgentStreamEvent, AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentTraceEvent } from '@blade-ai/agent/tracing';",
  ],
  publishedConsumer: [
    "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    "import type { AgentStreamEvent, AgentToolCall } from '@blade-ai/agent/protocol';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentTraceEvent } from '@blade-ai/agent/tracing';",
  ],
};

function getAgentPublicTypeImportLines(contractName) {
  const lines = agentPublicTypeImportContracts[contractName];
  if (!lines) {
    throw new Error(`Unknown agent public type import contract: ${contractName}`);
  }
  return lines;
}

export function createAgentPublicTypeImportLines(contractName) {
  return [...getAgentPublicTypeImportLines(contractName)];
}

export function createAgentPublicTypeImportBlock(contractName) {
  return getAgentPublicTypeImportLines(contractName).join('\n');
}
