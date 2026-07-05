import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mcpServersModulePath = '../../packages/agent-sdk/src/session/runtimeMcpServers.js';
const mcpServersSourcePath = 'packages/agent-sdk/src/session/runtimeMcpServers.ts';

describe('agent-sdk package-local runtime MCP server helpers', () => {
  it('detects in-process MCP server handles without session runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { isPackageLocalSdkMcpServerHandle } = await import(mcpServersModulePath);

    expect(
      isPackageLocalSdkMcpServerHandle({
        name: 'local',
        version: '1.0.0',
        server: {},
        createClientTransport: async () => ({}),
      }),
    ).toBe(true);

    expect(
      isPackageLocalSdkMcpServerHandle({
        command: 'node',
        args: ['server.js'],
      }),
    ).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle(null)).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle({ server: {} })).toBe(false);
  });
});
