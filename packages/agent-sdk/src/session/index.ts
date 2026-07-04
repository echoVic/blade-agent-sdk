import {
  createSession as createRootSession,
  forkSession as forkRootSession,
  prompt as promptRootSession,
  resumeSession as resumeRootSession,
} from '../../../../src/session/Session.js';
import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  UserMessageContent,
} from './types.js';

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

export async function createSession(options: SessionOptions): Promise<ISession> {
  return await createRootSession(options as never) as unknown as ISession;
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  return await resumeRootSession(options as never) as unknown as ISession;
}

export async function forkSession(options: ForkOptions): Promise<ISession> {
  return await forkRootSession(options as never) as unknown as ISession;
}

export async function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return await promptRootSession(message as never, options as never) as unknown as PromptResult;
}
