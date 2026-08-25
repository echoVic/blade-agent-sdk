// Node host capabilities: builtin tools, MCP, memory, and sandbox adapters.
// Browser consumers should use @blade-ai/agent-sdk/core or a remote server API.

import type { UserMessageContent } from '../agent/types.js';
import { PersistentStore } from '../context/storage/PersistentStore.js';
import { getContextCwd } from '../runtime/index.js';
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

function withNodeRepository(options: SessionOptions): SessionOptions {
  if (
    options.sessionRepository
    || options.sessionEventStore
    || options.persistSession === false
    || !options.storagePath
  ) {
    return options;
  }

  const persistence = new PersistentStore(
    options.storagePath,
    100,
    '0.0.10',
    getContextCwd(options.defaultContext),
  );
  return {
    ...options,
    sessionRepository: persistence,
    sessionEventStore: persistence,
  };
}

export function createSession(options: SessionOptions): Promise<ISession> {
  return createSessionWithHost(withNodeRepository(options), NODE_SESSION_HOST);
}

export function resumeSession(options: ResumeOptions): Promise<ISession> {
  return resumeSessionWithHost(withNodeRepository(options) as ResumeOptions, NODE_SESSION_HOST);
}

export function forkSession(options: ForkOptions): Promise<ISession> {
  return forkSessionWithHost(withNodeRepository(options) as ForkOptions, NODE_SESSION_HOST);
}

export function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return promptWithHost(message, withNodeRepository(options), NODE_SESSION_HOST);
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
export {
  PersistentStore,
  PersistentStore as JsonlSessionRepository,
} from '../context/storage/PersistentStore.js';
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
