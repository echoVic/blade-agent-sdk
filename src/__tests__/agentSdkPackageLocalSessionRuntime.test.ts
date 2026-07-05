import { describe, expect, it } from 'vitest';
import {
  isPackageLocalSdkMcpServerHandle,
  PackageLocalSessionRuntime,
  resolvePackageLocalRuntimeStorageRoot,
} from '../../packages/agent-sdk/src/session/runtimeInstance.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';
import type { BladeConfig } from '../../packages/agent-sdk/src/types/common.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

const bladeConfig: BladeConfig = {
  models: [],
  currentModelId: 'default',
  temperature: 0.7,
  permissions: {
    allow: [],
    deny: [],
  },
};

describe('agent-sdk package-local session runtime shell', () => {
  it('owns runtime storage root and project cwd derivation locally', () => {
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade/sessions')).toBe(
      '/workspace/.blade',
    );
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade')).toBe('/workspace/.blade');
    expect(resolvePackageLocalRuntimeStorageRoot(undefined)).toBeUndefined();

    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        storagePath: '/workspace/.blade/sessions',
      },
      bladeConfig: {
        ...bladeConfig,
        storageRoot: '/override/root',
      },
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: ['/project'],
            cwd: '/project',
          },
        },
        environment: {
          cwd: '/env-project',
        },
      },
    });

    expect(runtime.sessionId).toBe('session-1');
    expect(runtime.storageRoot).toBe('/override/root');
    expect(runtime.projectPath).toBe('/project');
    expect(runtime.hookCallbacks).toEqual({});
  });

  it('detects in-process MCP server handles without importing root MCP types', () => {
    const handle = {
      name: 'local',
      version: '1.0.0',
      server: {},
      createClientTransport: async () => ({}),
    };

    expect(isPackageLocalSdkMcpServerHandle(handle)).toBe(true);
    expect(
      isPackageLocalSdkMcpServerHandle({
        command: 'node',
        args: ['server.js'],
      }),
    ).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle(null)).toBe(false);
  });
});
