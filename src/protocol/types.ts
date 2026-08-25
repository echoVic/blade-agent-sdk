import type { UserMessageContent } from '../agent/types.js';
import type { SessionStreamEvent } from '../session/types.js';
import type {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  MessageId,
  PermissionRequestId,
  RequestId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';

export const AGENT_PROTOCOL_VERSION = 1 as const;
export type AgentProtocolVersion = typeof AGENT_PROTOCOL_VERSION;

export const AgentCommandType = {
  INITIALIZE: 'initialize',
  SESSION_CREATE: 'session.create',
  SESSION_READ: 'session.read',
  SESSION_LIST: 'session.list',
  SESSION_RESUME: 'session.resume',
  SESSION_FORK: 'session.fork',
  SESSION_CLOSE: 'session.close',
  INPUT_SUBMIT: 'input.submit',
  REQUEST_ABORT: 'request.abort',
  PERMISSION_RESOLVE: 'permission.resolve',
} as const;

export type AgentCommandType = (typeof AgentCommandType)[keyof typeof AgentCommandType];

export type AgentServerScope =
  | 'session:create'
  | 'session:read'
  | 'session:write'
  | 'session:admin'
  | 'permission:resolve';

export interface AgentPrincipal {
  readonly tenantId: string;
  readonly subject: string;
  readonly scopes: readonly AgentServerScope[];
}

export interface AgentClientInfo {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

export interface AgentClientCapabilities {
  readonly approvals?: boolean;
  readonly durableEvents?: boolean;
  readonly eventReplay?: boolean;
}

interface AgentCommandBase<TType extends AgentCommandType, TData> {
  readonly protocolVersion: AgentProtocolVersion;
  readonly commandId: CommandId;
  readonly type: TType;
  readonly data: TData;
}

export type InitializeCommand = AgentCommandBase<
  typeof AgentCommandType.INITIALIZE,
  {
    readonly client: AgentClientInfo;
    readonly capabilities?: AgentClientCapabilities;
  }
>;

export type CreateSessionCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_CREATE,
  {
    readonly metadata?: JsonObject;
  }
>;

export type ReadSessionCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_READ,
  {
    readonly sessionId: SessionId;
  }
>;

export type ListSessionsCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_LIST,
  {
    readonly cursor?: string;
    readonly limit?: number;
  }
>;

export type ResumeSessionCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_RESUME,
  {
    readonly sessionId: SessionId;
  }
>;

export type ForkSessionCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_FORK,
  {
    readonly sessionId: SessionId;
    readonly messageId?: MessageId;
    readonly metadata?: JsonObject;
  }
>;

export type CloseSessionCommand = AgentCommandBase<
  typeof AgentCommandType.SESSION_CLOSE,
  {
    readonly sessionId: SessionId;
  }
>;

export type SubmitInputCommand = AgentCommandBase<
  typeof AgentCommandType.INPUT_SUBMIT,
  {
    readonly sessionId: SessionId;
    readonly input: UserMessageContent;
    readonly priority?: 'now' | 'next' | 'later';
    readonly expectedRequestId?: RequestId;
    readonly maxTurns?: number;
  }
>;

export type AbortRequestCommand = AgentCommandBase<
  typeof AgentCommandType.REQUEST_ABORT,
  {
    readonly sessionId: SessionId;
  }
>;

export type ResolvePermissionCommand = AgentCommandBase<
  typeof AgentCommandType.PERMISSION_RESOLVE,
  {
    readonly sessionId: SessionId;
    readonly permissionRequestId: PermissionRequestId;
    readonly approved: boolean;
    readonly reason?: string;
    readonly scope?: 'once' | 'session';
  }
>;

export type AgentCommand =
  | InitializeCommand
  | CreateSessionCommand
  | ReadSessionCommand
  | ListSessionsCommand
  | ResumeSessionCommand
  | ForkSessionCommand
  | CloseSessionCommand
  | SubmitInputCommand
  | AbortRequestCommand
  | ResolvePermissionCommand;

export type AgentProtocolErrorCode =
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'INVALID_COMMAND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CONFLICT'
  | 'COMMAND_CONFLICT'
  | 'COMMAND_IN_PROGRESS'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'STALE_CURSOR'
  | 'PERMISSION_NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface AgentProtocolErrorData {
  readonly code: AgentProtocolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: JsonObject;
}

export interface AgentCommandSuccess<TData = unknown> {
  readonly protocolVersion: AgentProtocolVersion;
  readonly commandId: CommandId;
  readonly ok: true;
  readonly data: TData;
}

export interface AgentCommandFailure {
  readonly protocolVersion: AgentProtocolVersion;
  readonly commandId: CommandId;
  readonly ok: false;
  readonly error: AgentProtocolErrorData;
}

export type AgentCommandResult<TData = unknown> = AgentCommandSuccess<TData> | AgentCommandFailure;

export interface AgentSessionDescriptor {
  readonly sessionId: SessionId;
  readonly status: 'active' | 'closed';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: JsonObject;
}

export interface AgentEventCursor {
  readonly protocolVersion: AgentProtocolVersion;
  readonly sessionId: SessionId;
  readonly sequence: EventSequence;
  readonly eventId: EventId;
}

export interface AgentPermissionRequest {
  readonly permissionRequestId: PermissionRequestId;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly title: string;
  readonly message: string;
  readonly kind?: string;
  readonly affectedPaths: readonly string[];
  readonly risks: readonly string[];
}

export type AgentServerEvent =
  | {
      readonly protocolVersion: AgentProtocolVersion;
      readonly eventId: EventId;
      readonly sequence: EventSequence;
      readonly sessionId: SessionId;
      readonly requestId?: RequestId;
      readonly occurredAt: string;
      readonly type: 'session.stream';
      readonly data: SessionStreamEvent;
    }
  | {
      readonly protocolVersion: AgentProtocolVersion;
      readonly eventId: EventId;
      readonly sequence: EventSequence;
      readonly sessionId: SessionId;
      readonly requestId?: RequestId;
      readonly occurredAt: string;
      readonly type: 'permission.requested';
      readonly data: AgentPermissionRequest;
    }
  | {
      readonly protocolVersion: AgentProtocolVersion;
      readonly eventId: EventId;
      readonly sequence: EventSequence;
      readonly sessionId: SessionId;
      readonly requestId?: RequestId;
      readonly occurredAt: string;
      readonly type: 'session.closed';
      readonly data: JsonObject;
    };

export interface AgentProtocolCapabilities {
  readonly protocolVersion: AgentProtocolVersion;
  readonly commands: readonly AgentCommandType[];
  readonly transports: readonly ['http-sse'];
  readonly features: {
    readonly approvals: true;
    readonly durableEvents: true;
    readonly eventReplay: true;
    readonly idempotentCommands: true;
  };
}

export interface AgentInitializationData extends AgentProtocolCapabilities {
  readonly serverTime: string;
}

export interface AgentEventPage {
  readonly events: readonly AgentServerEvent[];
  readonly nextCursor: AgentEventCursor | null;
  readonly hasMore: boolean;
}

export interface AgentInputSubmissionData {
  readonly sessionId: SessionId;
  readonly inputId: InputId;
  readonly requestId?: RequestId;
  readonly status: 'started' | 'steered' | 'queued';
  readonly priority?: 'now' | 'next' | 'later';
}
