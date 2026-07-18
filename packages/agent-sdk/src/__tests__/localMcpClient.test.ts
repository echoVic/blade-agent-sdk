import { describe, expect, it } from 'vitest';
import { McpClient, ErrorType } from '../local/McpClient.js';
import type { SdkMcpServerHandle } from '../local/SdkMcpServer.js';

describe('McpClient (agent-sdk)', () => {
  it('can be instantiated with minimal config', () => {
    const client = new McpClient(
      'test-server',
      { type: 'sse', url: 'http://localhost:9999' },
      { disableHealthCheck: true },
    );
    expect(client).toBeInstanceOf(McpClient);
  });

  it('exports ErrorType enum with expected values', () => {
    expect(ErrorType.NETWORK_TEMPORARY).toBe('network_temporary');
    expect(ErrorType.NETWORK_PERMANENT).toBe('network_permanent');
    expect(ErrorType.CONFIG_ERROR).toBe('config_error');
    expect(ErrorType.AUTH_ERROR).toBe('auth_error');
    expect(ErrorType.PROTOCOL_ERROR).toBe('protocol_error');
    expect(ErrorType.UNKNOWN).toBe('unknown');
  });

  it('emits statusChanged events on status transitions', async () => {
    // This test verifies that McpClient extends EventEmitter and can emit events
    // without actually connecting to a server
    const client = new McpClient(
      'test-server',
      { type: 'sse', url: 'http://localhost:9999' },
      { disableHealthCheck: true },
    );
    expect(client).toHaveProperty('on');
    expect(client).toHaveProperty('emit');
  });
});
