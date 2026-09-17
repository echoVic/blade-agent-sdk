import { SdkError } from '../errors/SdkError.js';
import type { DurableExecutionLeaseStore } from '../session/events/DurableExecutionLeaseStore.js';
import type { SessionEventStore, SessionRepository } from '../session/SessionRepository.js';
import type { AgentServerStore } from './AgentServerStore.js';
import type { WorkerRuntimeStore } from './WorkerRuntime.js';

export const RUNTIME_STORE_SCHEMA_VERSION = 5 as const;

export interface RuntimeStore extends AgentServerStore, WorkerRuntimeStore {
  initialize(): Promise<void>;
  forTenant(tenantId: string): RuntimeTenantStore;
  close(): Promise<void>;
}

export interface RuntimeTenantStore
  extends SessionRepository,
    SessionEventStore,
    DurableExecutionLeaseStore {}

export type RuntimeStoreErrorCode =
  | 'RUNTIME_STORE_QUOTA_EXCEEDED'
  | 'RUNTIME_STORE_INVALID_TRANSACTION';

export class RuntimeStoreError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(code: RuntimeStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}
