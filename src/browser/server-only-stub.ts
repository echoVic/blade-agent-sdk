function serverOnly(name: string): never {
  throw new Error(
    `@blade-ai/agent-sdk is server-only for ${name}. Use it from a Node server, API route, server action, or CLI process. Browser clients should import AgentClient from @blade-ai/agent-sdk/browser or contracts from @blade-ai/agent-sdk/protocol.`,
  );
}

export function createSession(..._args: unknown[]): never {
  return serverOnly('createSession');
}

export function resumeSession(..._args: unknown[]): never {
  return serverOnly('resumeSession');
}

export function forkSession(..._args: unknown[]): never {
  return serverOnly('forkSession');
}

export function prompt(..._args: unknown[]): never {
  return serverOnly('prompt');
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
