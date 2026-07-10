const aiPublicTypeImportContracts = {
  localDeclaration: [
    "import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent, UsageInfo as ModelUsageInfo } from '@blade-ai/ai/model';",
    "import type { ChatConfig, ChatResponse, Message as ChatMessage, StreamChunk as ChatStreamChunk, UsageInfo as ChatUsageInfo } from '@blade-ai/ai/chat';",
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
    "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentStreamEvent } from '@blade-ai/agent/protocol';",
    "import type { AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    "import type { AgentTraceEvent, AgentTracePort, BufferedAgentTracePort, BufferedAgentTracePortOptions } from '@blade-ai/agent/tracing';",
  ],
  packedConsumer: [
    "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    "import type { AgentStreamEvent, AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentTraceEvent, AgentTracePort, BufferedAgentTracePort, BufferedAgentTracePortOptions } from '@blade-ai/agent/tracing';",
  ],
  publishedConsumer: [
    "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    "import type { AgentStreamEvent, AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    "import type { AgentToolPort } from '@blade-ai/agent/ports';",
    "import type { AgentTraceEvent, AgentTracePort, BufferedAgentTracePort, BufferedAgentTracePortOptions } from '@blade-ai/agent/tracing';",
  ],
};

const sdkPublicTypeImportContracts = {
  localDeclaration: [
    "import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';",
    "import type { RuntimeContext } from '@blade-ai/agent-sdk/core';",
    "import type { SdkErrorOptions } from '@blade-ai/agent-sdk/errors';",
    "import type { ISession } from '@blade-ai/agent-sdk/session';",
    "import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';",
  ],
  packedConsumer: [
    "import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';",
    "import type { JsonObject as CoreJsonObject, PermissionHandler, RuntimeContext, StreamMessage as CoreStreamMessage, ToolDefinition as CoreToolDefinition } from '@blade-ai/agent-sdk/core';",
    "import type { SdkErrorOptions } from '@blade-ai/agent-sdk/errors';",
    "import type { ISession as SubpathSession, ResumeOptions, SessionOptions as SubpathSessionOptions } from '@blade-ai/agent-sdk/session';",
    "import type { ToolDefinition as ToolsToolDefinition, ToolResult as ToolsToolResult } from '@blade-ai/agent-sdk/tools';",
    "import type { BuiltinToolsOptions } from '@blade-ai/agent-sdk/local';",
    "import type { ClaudeCodePermissionMode, ISession as ServerSession, PermissionsConfig as ServerPermissionsConfig, SubagentExecutionRunner, SubagentFrontmatter } from '@blade-ai/agent-sdk/server';",
    "import type { StreamMessage as BrowserStreamMessage } from '@blade-ai/agent-sdk/browser';",
  ],
  publishedConsumer: [
    "import type { SessionOptions, StreamMessage, ToolDefinition } from '@blade-ai/agent-sdk';",
    "import type { StreamMessage as BrowserStreamMessage } from '@blade-ai/agent-sdk/browser';",
    "import type { SdkErrorOptions } from '@blade-ai/agent-sdk/errors';",
    "import type { ISession } from '@blade-ai/agent-sdk/session';",
    "import type { ClaudeCodePermissionMode, ISession as ServerSession, PermissionsConfig as ServerPermissionsConfig, SubagentExecutionRunner, SubagentFrontmatter } from '@blade-ai/agent-sdk/server';",
    "import type { ToolDefinition as SubpathToolDefinition } from '@blade-ai/agent-sdk/tools';",
    "import type { BuiltinToolsOptions } from '@blade-ai/agent-sdk/local';",
    "import type { PermissionMode, RuntimeContext } from '@blade-ai/agent-sdk/core';",
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

function getSdkPublicTypeImportLines(contractName) {
  const lines = sdkPublicTypeImportContracts[contractName];
  if (!lines) {
    throw new Error(`Unknown SDK public type import contract: ${contractName}`);
  }
  return lines;
}

export function createAiPublicTypeImportLines(contractName) {
  return [...getAiPublicTypeImportLines(contractName)];
}

export function createAiPublicTypeImportBlock(contractName) {
  return getAiPublicTypeImportLines(contractName).join('\n');
}

export function createSdkPublicTypeImportLines(contractName) {
  return [...getSdkPublicTypeImportLines(contractName)];
}

export function createSdkPublicTypeImportBlock(contractName) {
  return getSdkPublicTypeImportLines(contractName).join('\n');
}

export function createAgentPublicTypeImportLines(contractName) {
  return [...getAgentPublicTypeImportLines(contractName)];
}

export function createAgentPublicTypeImportBlock(contractName) {
  return getAgentPublicTypeImportLines(contractName).join('\n');
}
