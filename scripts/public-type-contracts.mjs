const aiPublicTypeImportContracts = {
  localDeclaration: [
    "import type { ModelPort } from '@blade-ai/ai/model';",
    "import type { ChatConfig } from '@blade-ai/ai/chat';",
    "import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';",
    "import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';",
    "import type { RetryConfig } from '@blade-ai/ai/retry';",
  ],
  packedConsumer: [
    "import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent } from '@blade-ai/ai';",
    "import type { ChatConfig, ChatResponse, Message as ChatMessage, StreamChunk as ChatStreamChunk, UsageInfo as ChatUsageInfo } from '@blade-ai/ai/chat';",
    "import type { ModelMessage, ModelRequest as ModelSubpathRequest, ModelResponse as ModelSubpathResponse, ModelStreamEvent as ModelSubpathStreamEvent, UsageInfo as ModelSubpathUsageInfo } from '@blade-ai/ai/model';",
    "import type { QuerySource, RetryConfig, RetryContext, RetryEvent } from '@blade-ai/ai/retry';",
    "import type { DeepSeekCostBreakdown, DeepSeekProviderOptions } from '@blade-ai/ai/deepseek';",
    "import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';",
    "import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';",
  ],
  publishedConsumer: [
    "import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent } from '@blade-ai/ai';",
    "import type { ChatConfig, ChatResponse, Message as ChatMessage, StreamChunk as ChatStreamChunk, UsageInfo as ChatUsageInfo } from '@blade-ai/ai/chat';",
    "import type { ModelMessage, ModelRequest as ModelSubpathRequest, ModelResponse as ModelSubpathResponse, ModelStreamEvent as ModelSubpathStreamEvent, UsageInfo as ModelSubpathUsageInfo } from '@blade-ai/ai/model';",
    "import type { QuerySource, RetryConfig, RetryContext, RetryEvent } from '@blade-ai/ai/retry';",
    "import type { DeepSeekCostBreakdown, DeepSeekProviderOptions } from '@blade-ai/ai/deepseek';",
    "import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';",
    "import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';",
  ],
};

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

function getAiPublicTypeImportLines(contractName) {
  const lines = aiPublicTypeImportContracts[contractName];
  if (!lines) {
    throw new Error(`Unknown AI public type import contract: ${contractName}`);
  }
  return lines;
}

function getAgentPublicTypeImportLines(contractName) {
  const lines = agentPublicTypeImportContracts[contractName];
  if (!lines) {
    throw new Error(`Unknown agent public type import contract: ${contractName}`);
  }
  return lines;
}

export function createAiPublicTypeImportLines(contractName) {
  return [...getAiPublicTypeImportLines(contractName)];
}

export function createAiPublicTypeImportBlock(contractName) {
  return getAiPublicTypeImportLines(contractName).join('\n');
}

export function createAgentPublicTypeImportLines(contractName) {
  return [...getAgentPublicTypeImportLines(contractName)];
}

export function createAgentPublicTypeImportBlock(contractName) {
  return getAgentPublicTypeImportLines(contractName).join('\n');
}
