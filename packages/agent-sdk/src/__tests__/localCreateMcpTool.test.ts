import { describe, expect, it } from 'vitest';
import { createMcpTool } from '../local/createMcpTool.js';
import type { McpClientLike, McpToolCallResponse, McpToolDefinition } from '../local/mcpTypes.js';
import { McpConnectionStatus } from '../local/mcpTypes.js';

// Minimal stub matching McpClientLike
class MockMcpClient implements McpClientLike {
  connectionStatus: McpConnectionStatus = McpConnectionStatus.CONNECTED;
  availableTools: ReadonlyArray<{ name: string; description: string }> = [];
  server: { name: string; version: string } | null = { name: 'test', version: '1.0.0' };

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  callTool(_name: string, _params: Record<string, unknown>): Promise<McpToolCallResponse> {
    return Promise.resolve({ content: [{ type: 'text', text: `called ${_name}` }], isError: false });
  }
}

const sampleDef: McpToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
};

describe('createMcpTool (agent-sdk)', () => {
  it('converts a McpToolDefinition into a Tool', () => {
    const client = new MockMcpClient();
    const tool = createMcpTool(client, 'test-server', sampleDef);
    expect(tool).toBeDefined();
    expect(tool.name).toBe('test_tool');
    expect(tool.kind).toBe('execute');
  });
});
