import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  UserMessageContent,
} from './types.js';
import type { SessionRuntimeFactory } from './factory.js';

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
  SessionImageContentPart,
  SessionMessage,
  SessionMessageRole,
  SessionOptions,
  SessionTool,
  SessionTextContentPart,
  SessionToolCall,
  StreamMessage,
  StreamOptions,
  SubagentInfo,
  TokenBudgetConfig,
  TokenBudgetSnapshot,
  ToolCallRecord,
  ToolCatalogSourcePolicy,
  ToolDefinition,
  ToolResult,
  ToolSourceKind,
  ToolTrustLevel,
  UserMessageContent,
} from './types.js';
export type { SessionRuntimeFactory } from './factory.js';

export declare function createSession(options: SessionOptions): Promise<ISession>;
export declare function resumeSession(options: ResumeOptions): Promise<ISession>;
export declare function forkSession(options: ForkOptions): Promise<ISession>;
export declare function setSessionRuntimeFactory(
  factory: SessionRuntimeFactory,
): () => void;
export declare function resetSessionRuntimeFactory(): void;
export declare function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult>;

// Branded session identifier + constructor (canonical in local/branded.js).
// Exported as a VALUE so session-layer consumers can construct branded ids
// without reaching into @blade-ai/agent-sdk/local.
export { SessionId } from '../local/branded.js';
