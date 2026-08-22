declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ToolUseId = Brand<string, 'ToolUseId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type InputId = Brand<string, 'InputId'>;

export const SessionId = (value: string): SessionId => value as SessionId;
export const AgentId = (value: string): AgentId => value as AgentId;
export const MessageId = (value: string): MessageId => value as MessageId;
export const ToolUseId = (value: string): ToolUseId => value as ToolUseId;
export const RequestId = (value: string): RequestId => value as RequestId;
export const InputId = (value: string): InputId => value as InputId;
