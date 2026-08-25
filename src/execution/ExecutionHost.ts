import { SdkError } from '../errors/SdkError.js';
import type {
  ExecutionCheckpointId,
  ExecutionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { CredentialRequest } from './CredentialBroker.js';

export interface ExecutionResourceLimits {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly pids: number;
  readonly runtimeMs: number;
  readonly maxOutputBytes: number;
}

export type ExecutionNetworkPolicy =
  | {
      readonly mode: 'none';
    }
  | {
      readonly mode: 'proxy';
      readonly allowedHosts: readonly string[];
    };

export type ExecutionWorkspaceSource =
  | {
      readonly kind: 'empty';
    }
  | {
      readonly kind: 'git-worktree';
      readonly repositoryPath: string;
      readonly revision: string;
    };

export interface ExecutionProvisionRequest {
  readonly executionId?: ExecutionId;
  readonly image: string;
  readonly workspace: ExecutionWorkspaceSource;
  readonly resources: ExecutionResourceLimits;
  readonly network: ExecutionNetworkPolicy;
  readonly environment?: Readonly<Record<string, string>>;
  readonly metadata?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface ExecutionHandle {
  readonly executionId: ExecutionId;
  readonly state: 'provisioned' | 'terminated';
  readonly image: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resources: ExecutionResourceLimits;
  readonly network: ExecutionNetworkPolicy;
  readonly metadata: JsonObject;
}

export interface ExecutionExecRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly credentials?: readonly CredentialRequest[];
  readonly timeoutMs?: number;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export interface ExecutionExecResult {
  readonly executionId: ExecutionId;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ExecutionCheckpoint {
  readonly checkpointId: ExecutionCheckpointId;
  readonly sourceExecutionId: ExecutionId;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly metadata: JsonObject;
}

export interface ExecutionRestoreRequest {
  readonly checkpointId: ExecutionCheckpointId;
  readonly executionId?: ExecutionId;
  readonly signal?: AbortSignal;
}

export interface ExecutionEgressLease {
  readonly networkName: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ExecutionEgressController {
  provision(
    executionId: ExecutionId,
    policy: Extract<ExecutionNetworkPolicy, { mode: 'proxy' }>,
    signal?: AbortSignal,
  ): Promise<ExecutionEgressLease>;
  release(executionId: ExecutionId): Promise<void>;
}

export interface ExecutionHost {
  provision(request: ExecutionProvisionRequest): Promise<ExecutionHandle>;
  exec(
    executionId: ExecutionId,
    request: ExecutionExecRequest,
  ): Promise<ExecutionExecResult>;
  checkpoint(
    executionId: ExecutionId,
    metadata?: JsonObject,
  ): Promise<ExecutionCheckpoint>;
  restore(request: ExecutionRestoreRequest): Promise<ExecutionHandle>;
  terminate(executionId: ExecutionId): Promise<void>;
}

export type ExecutionHostErrorCode =
  | 'EXECUTION_INVALID_REQUEST'
  | 'EXECUTION_HOST_UNAVAILABLE'
  | 'EXECUTION_NOT_FOUND'
  | 'EXECUTION_ALREADY_EXISTS'
  | 'EXECUTION_RESOURCE_LIMIT'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_OUTPUT_LIMIT'
  | 'EXECUTION_NETWORK_POLICY'
  | 'EXECUTION_CHECKPOINT_NOT_FOUND'
  | 'EXECUTION_CHECKPOINT_INVALID'
  | 'EXECUTION_CREDENTIAL_ERROR'
  | 'EXECUTION_RUNTIME_ERROR';

export class ExecutionHostError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: ExecutionHostErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}
