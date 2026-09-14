function serverOnly(name: string): never {
  throw new Error(
    `@blade-ai/agent-sdk is server-only for ${name}. Use it from a Node server, API route, server action, or CLI process. Browser clients should import AgentClient and protocol contracts from @blade-ai/agent-sdk/browser.`,
  );
}

export function createAgent(..._args: unknown[]): never {
  return serverOnly('createAgent');
}

export function createSession(..._args: unknown[]): never {
  return serverOnly('createSession');
}

export function createNodeSession(..._args: unknown[]): never {
  return serverOnly('createNodeSession');
}

export function createServerSession(..._args: unknown[]): never {
  return serverOnly('createServerSession');
}

export function resumeSession(..._args: unknown[]): never {
  return serverOnly('resumeSession');
}

export function resumeNodeSession(..._args: unknown[]): never {
  return serverOnly('resumeNodeSession');
}

export function resumeServerSession(..._args: unknown[]): never {
  return serverOnly('resumeServerSession');
}

export function forkSession(..._args: unknown[]): never {
  return serverOnly('forkSession');
}

export function forkNodeSession(..._args: unknown[]): never {
  return serverOnly('forkNodeSession');
}

export function forkServerSession(..._args: unknown[]): never {
  return serverOnly('forkServerSession');
}

export function prompt(..._args: unknown[]): never {
  return serverOnly('prompt');
}

export function promptNode(..._args: unknown[]): never {
  return serverOnly('promptNode');
}

export function promptServer(..._args: unknown[]): never {
  return serverOnly('promptServer');
}

export function getBuiltinTools(..._args: unknown[]): never {
  return serverOnly('getBuiltinTools');
}

export function createMemoryReadTool(..._args: unknown[]): never {
  return serverOnly('createMemoryReadTool');
}

export function createMemoryWriteTool(..._args: unknown[]): never {
  return serverOnly('createMemoryWriteTool');
}

export function createSdkMcpServer(..._args: unknown[]): never {
  return serverOnly('createSdkMcpServer');
}

export function tool(..._args: unknown[]): never {
  return serverOnly('tool');
}

export class FileSystemMemoryStore {
  constructor(..._args: unknown[]) {
    serverOnly('FileSystemMemoryStore');
  }
}

export class MemoryManager {
  constructor(..._args: unknown[]) {
    serverOnly('MemoryManager');
  }
}

export class JsonlDurableEventStore {
  constructor(..._args: unknown[]) {
    serverOnly('JsonlDurableEventStore');
  }
}

export class JsonlSessionRepository {
  constructor(..._args: unknown[]) {
    serverOnly('JsonlSessionRepository');
  }
}

export class AgentServer {
  constructor(..._args: unknown[]) {
    serverOnly('AgentServer');
  }
}

export class InProcessSessionExecutor {
  constructor(..._args: unknown[]) {
    serverOnly('InProcessSessionExecutor');
  }
}

export class SdkSessionRunner {
  constructor(..._args: unknown[]) {
    serverOnly('SdkSessionRunner');
  }
}

export class AgentWorker {
  constructor(..._args: unknown[]) {
    serverOnly('AgentWorker');
  }
}

export class AgentRuntimeOperations {
  constructor(..._args: unknown[]) {
    serverOnly('AgentRuntimeOperations');
  }
}

export class EffectDispatcher {
  constructor(..._args: unknown[]) {
    serverOnly('EffectDispatcher');
  }
}

export class RetryableRuntimeEffectError {
  constructor(..._args: unknown[]) {
    serverOnly('RetryableRuntimeEffectError');
  }
}

export class UncertainRuntimeEffectError {
  constructor(..._args: unknown[]) {
    serverOnly('UncertainRuntimeEffectError');
  }
}

export class ExecutionHostSessionRunner {
  constructor(..._args: unknown[]) {
    serverOnly('ExecutionHostSessionRunner');
  }
}

export class InMemoryAgentServerStore {
  constructor(..._args: unknown[]) {
    serverOnly('InMemoryAgentServerStore');
  }
}

export class PostgresRuntimeStore {
  constructor(..._args: unknown[]) {
    serverOnly('PostgresRuntimeStore');
  }
}

export class DockerExecutionHost {
  constructor(..._args: unknown[]) {
    serverOnly('DockerExecutionHost');
  }
}

export class EphemeralCredentialBroker {
  constructor(..._args: unknown[]) {
    serverOnly('EphemeralCredentialBroker');
  }
}

export class ExecutionHostError {
  constructor(..._args: unknown[]) {
    serverOnly('ExecutionHostError');
  }
}

export class WorkerRuntimeError {
  constructor(..._args: unknown[]) {
    serverOnly('WorkerRuntimeError');
  }
}

export const RUNTIME_STORE_SCHEMA_VERSION = 3;
export const RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION = 1;
export const RUNTIME_SESSION_STATES = [
  'queued',
  'provisioning',
  'running',
  'waiting_approval',
  'suspended',
  'idle',
  'completed',
  'failed',
] as const;

export function assertRuntimeSessionTransition(..._args: unknown[]): never {
  return serverOnly('assertRuntimeSessionTransition');
}

export function canTransitionRuntimeSession(..._args: unknown[]): never {
  return serverOnly('canTransitionRuntimeSession');
}

export function effectLease(..._args: unknown[]): never {
  return serverOnly('effectLease');
}

export function isTerminalRuntimeEffectStatus(..._args: unknown[]): never {
  return serverOnly('isTerminalRuntimeEffectStatus');
}

export class TenantAdmissionController {
  constructor(..._args: unknown[]) {
    serverOnly('TenantAdmissionController');
  }
}

export class OpenTelemetryAgentServerTelemetry {
  constructor(..._args: unknown[]) {
    serverOnly('OpenTelemetryAgentServerTelemetry');
  }
}

export class OpenTelemetryAgentWorkerTelemetry {
  constructor(..._args: unknown[]) {
    serverOnly('OpenTelemetryAgentWorkerTelemetry');
  }
}

export function assertRuntimeStoreConformance(..._args: unknown[]): never {
  return serverOnly('assertRuntimeStoreConformance');
}

export function assertAgentServerStoreConformance(..._args: unknown[]): never {
  return serverOnly('assertAgentServerStoreConformance');
}

export function assertSessionExecutorReadResult(..._args: unknown[]): never {
  return serverOnly('assertSessionExecutorReadResult');
}
