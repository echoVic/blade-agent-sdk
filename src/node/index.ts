// Node host capabilities: builtin tools, MCP, memory, and sandbox adapters.
// Browser consumers should use @blade-ai/agent-sdk/core or a remote server API.

import type { UserMessageContent } from '../agent/types.js';
import {
  createSessionWithHost,
  type ForkOptions,
  forkSessionWithHost,
  promptWithHost,
  type ResumeOptions,
  resumeSessionWithHost,
} from '../session/Session.js';
import { NODE_SESSION_HOST } from '../session/SessionHostProfile.js';
import type { ISession, PromptResult, SessionOptions } from '../session/types.js';

export * from '../index.js';

export function createSession(options: SessionOptions): Promise<ISession> {
  return createSessionWithHost(options, NODE_SESSION_HOST);
}

export function resumeSession(options: ResumeOptions): Promise<ISession> {
  return resumeSessionWithHost(options, NODE_SESSION_HOST);
}

export function forkSession(options: ForkOptions): Promise<ISession> {
  return forkSessionWithHost(options, NODE_SESSION_HOST);
}

export function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return promptWithHost(message, options, NODE_SESSION_HOST);
}

export type {
  McpToolCallResponse,
  McpToolDefinition,
  SdkMcpServerHandle,
  SdkTool,
  ToolResponse as McpToolResponse,
} from '../mcp/index.js';
export { createSdkMcpServer, tool } from '../mcp/index.js';
export { FileSystemMemoryStore, MemoryManager } from '../memory/index.js';
export type {
  SandboxCapabilities,
  SandboxCheckResult,
  SandboxExecutionContext,
  SandboxExecutionOptions,
} from '../sandbox/index.js';
export {
  getSandboxExecutor,
  getSandboxService,
  SandboxExecutor,
  SandboxService,
} from '../sandbox/index.js';
export {
  JsonlDurableEventStore,
  type JsonlDurableEventStoreOptions,
} from '../session/events/JsonlDurableEventStore.js';
export { getBuiltinTools } from '../tools/builtin/index.js';
export { createMemoryReadTool, createMemoryWriteTool } from '../tools/builtin/memory/index.js';
