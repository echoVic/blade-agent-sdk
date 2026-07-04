import {
  createDefaultSessionRuntimeFactory,
} from './runtimeFactory.js';
import { prompt as runPromptLifecycle } from './Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  UserMessageContent,
} from './types.js';

let sessionRuntimeFactory: SessionRuntimeFactory = createDefaultSessionRuntimeFactory();

export function setSessionRuntimeFactory(
  factory: SessionRuntimeFactory,
): () => void {
  const previousFactory = sessionRuntimeFactory;
  sessionRuntimeFactory = factory;
  return () => {
    sessionRuntimeFactory = previousFactory;
  };
}

export function resetSessionRuntimeFactory(): void {
  sessionRuntimeFactory = createDefaultSessionRuntimeFactory();
}

export type {
  AgentDefinition,
  AgentLogger,
  ForkOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HookCallback,
  HookInput,
  HookOutput,
  ISession,
  LogEntry,
  LogLevelName,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PromptResult,
  ProviderConfig,
  ResumeOptions,
  SdkMcpServerHandle,
  SendOptions,
  SessionContentPart,
  SessionHookEvent,
  SessionId,
  SessionImageContentPart,
  SessionMessage,
  SessionMessageRole,
  SessionOptions,
  SessionTextContentPart,
  SessionToolCall,
  StreamMessage,
  StreamOptions,
  SubagentInfo,
  TokenBudgetConfig,
  ToolCallRecord,
  ToolCatalogSourcePolicy,
  ToolDefinition,
  ToolResult,
  ToolSourceKind,
  ToolTrustLevel,
  UserMessageContent,
} from './types.js';
export type { SessionRuntimeFactory } from './factory.js';

export async function createSession(options: SessionOptions): Promise<ISession> {
  return sessionRuntimeFactory.create(options);
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'resumeSession() requires session persistence. Remove persistSession: false or use createSession().',
    );
  }
  return sessionRuntimeFactory.resume(options);
}

export async function forkSession(options: ForkOptions): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'forkSession() requires session persistence. Remove persistSession: false and call session.fork() on a live session instead.',
    );
  }
  return sessionRuntimeFactory.fork(options);
}

export async function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return runPromptLifecycle(sessionRuntimeFactory, message, options);
}
