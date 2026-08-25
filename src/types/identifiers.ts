export declare const identifierBrand: unique symbol;

export type Identifier<TValue, TName extends string> = TValue & {
  readonly [identifierBrand]: TName;
};

export type SessionId = Identifier<string, 'SessionId'>;
export type AgentId = Identifier<string, 'AgentId'>;
export type MessageId = Identifier<string, 'MessageId'>;
export type PartId = Identifier<string, 'PartId'>;
export type ToolUseId = Identifier<string, 'ToolUseId'>;
export type RequestId = Identifier<string, 'RequestId'>;
export type InputId = Identifier<string, 'InputId'>;
export type EventId = Identifier<string, 'EventId'>;
export type EventSequence = Identifier<number, 'EventSequence'>;
export type TurnId = Identifier<string, 'TurnId'>;
export type ModelAttemptId = Identifier<string, 'ModelAttemptId'>;
export type ToolAttemptId = Identifier<string, 'ToolAttemptId'>;
export type CommandId = Identifier<string, 'CommandId'>;
export type PermissionRequestId = Identifier<string, 'PermissionRequestId'>;
export type WorkerId = Identifier<string, 'WorkerId'>;
export type ExecutionLeaseId = Identifier<string, 'ExecutionLeaseId'>;
export type FencingToken = Identifier<number, 'FencingToken'>;
export type ExecutionId = Identifier<string, 'ExecutionId'>;
export type ExecutionCheckpointId = Identifier<string, 'ExecutionCheckpointId'>;
export type CredentialLeaseId = Identifier<string, 'CredentialLeaseId'>;
export type TraceId = Identifier<string, 'TraceId'>;
export type SpanId = Identifier<string, 'SpanId'>;
export type TraceEventId = Identifier<string, 'TraceEventId'>;

export const SessionId = (value: string): SessionId => value as SessionId;
export const AgentId = (value: string): AgentId => value as AgentId;
export const MessageId = (value: string): MessageId => value as MessageId;
export const PartId = (value: string): PartId => value as PartId;
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
export const ExecutionId = (value: string): ExecutionId => value as ExecutionId;
export const ExecutionCheckpointId = (
  value: string,
): ExecutionCheckpointId => value as ExecutionCheckpointId;
export const CredentialLeaseId = (
  value: string,
): CredentialLeaseId => value as CredentialLeaseId;
export const TraceId = (value: string): TraceId => value as TraceId;
export const SpanId = (value: string): SpanId => value as SpanId;
export const TraceEventId = (value: string): TraceEventId => value as TraceEventId;
