import { describe, expect, it } from 'vitest';
import {
  listPackageLocalRuntimeMcpTools,
  projectPackageLocalRuntimeMcpServerStatus,
  type PackageLocalRuntimeMcpServerCapability,
} from '../../packages/agent-sdk/src/session/runtimeMcpCapabilities.js';

describe('agent-sdk package-local MCP capability helpers', () => {
  const connectedAt = new Date('2026-07-06T00:00:00.000Z');
  const capabilities: PackageLocalRuntimeMcpServerCapability[] = [
    {
      name: 'server-a',
      status: 'connected',
      connectedAt,
      auth: {
        enabled: false,
      },
      health: {
        enabled: false,
        status: 'disabled',
      },
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: {},
        },
      ],
    },
    {
      name: 'server-b',
      status: 'error',
      error: 'failed',
      auth: {
        enabled: true,
        provider: 'github',
      },
      health: {
        enabled: true,
        status: 'unhealthy',
      },
      tools: [
        {
          name: 'read',
          description: 'Read docs',
          inputSchema: {},
        },
        {
          name: 'write',
          description: 'Write docs',
          inputSchema: {},
        },
      ],
    },
  ];

  it('projects server capabilities into public MCP server status', () => {
    expect(projectPackageLocalRuntimeMcpServerStatus(capabilities)).toEqual([
      {
        name: 'server-a',
        status: 'connected',
        toolCount: 1,
        tools: ['search'],
        connectedAt,
        error: undefined,
      },
      {
        name: 'server-b',
        status: 'error',
        toolCount: 2,
        tools: ['read', 'write'],
        connectedAt: undefined,
        error: 'failed',
      },
    ]);
  });

  it('projects server capabilities into public MCP tool info', () => {
    expect(listPackageLocalRuntimeMcpTools(capabilities)).toEqual([
      {
        name: 'search',
        description: 'Search docs',
        serverName: 'server-a',
      },
      {
        name: 'read',
        description: 'Read docs',
        serverName: 'server-b',
      },
      {
        name: 'write',
        description: 'Write docs',
        serverName: 'server-b',
      },
    ]);
  });
});
