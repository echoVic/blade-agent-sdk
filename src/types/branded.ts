declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ToolUseId = Brand<string, 'ToolUseId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type InputId = Brand<string, 'InputId'>;
export type EventId = Brand<string, 'EventId'>;
export type EventSequence = Brand<number, 'EventSequence'>;
export type TurnId = Brand<string, 'TurnId'>;
export type ModelAttemptId = Brand<string, 'ModelAttemptId'>;
export type ToolAttemptId = Brand<string, 'ToolAttemptId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type PermissionRequestId = Brand<string, 'PermissionRequestId'>;
export type WorkerId = Brand<string, 'WorkerId'>;
export type ExecutionLeaseId = Brand<string, 'ExecutionLeaseId'>;
export type FencingToken = Brand<number, 'FencingToken'>;

export const SessionId = (value: string): SessionId => value as SessionId;
export const AgentId = (value: string): AgentId => value as AgentId;
export const MessageId = (value: string): MessageId => value as MessageId;
export const ToolUseId = (value: string): ToolUseId => value as ToolUseId;
export const RequestId = (value: string): RequestId => value as RequestId;
export const InputId = (value: string): InputId => value as InputId;
export const EventId = (value: string): EventId => value as EventId;
export const EventSequence = (value: number): EventSequence => value as EventSequence;
export const TurnId = (value: string): TurnId => value as TurnId;
export const ModelAttemptId = (value: string): ModelAttemptId => value as ModelAttemptId;
export const ToolAttemptId = (value: string): ToolAttemptId => value as ToolAttemptId;
export const CommandId = (value: string): CommandId => value as CommandId;
export const PermissionRequestId = (value: string): PermissionRequestId =>
  value as PermissionRequestId;
export const WorkerId = (value: string): WorkerId => value as WorkerId;
export const ExecutionLeaseId = (value: string): ExecutionLeaseId => value as ExecutionLeaseId;
export const FencingToken = (value: number): FencingToken => value as FencingToken;
