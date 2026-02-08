import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readMcpResourceTool } from '../readMcpResource.js';

const mockGetAllServers = mock(() => new Map());

mock.module('../../../../mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: () => ({
      getAllServers: mockGetAllServers,
    }),
  },
}));

describe('readMcpResourceTool', () => {
  beforeEach(() => {
    mockGetAllServers.mockClear();
  });

  afterEach(() => {
    mockGetAllServers.mockClear();
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(readMcpResourceTool.name).toBe('ReadMcpResource');
    });

    it('should have correct displayName', () => {
      expect(readMcpResourceTool.displayName).toBe('Read MCP Resource');
    });
  });

  describe('execute', () => {
    it('should return error when no servers connected', async () => {
      mockGetAllServers.mockReturnValue(new Map());

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toBe('No MCP servers are currently connected.');
    });

    it('should read text resource successfully', async () => {
      const mockClient = {
        readResource: mock(() =>
          Promise.resolve({
            uri: 'file:///test.txt',
            text: 'Hello, World!',
            mimeType: 'text/plain',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('Hello, World!');
      expect(result.metadata?.hasText).toBe(true);
      expect(result.metadata?.contentLength).toBe(13);
    });

    it('should read blob resource successfully', async () => {
      const mockClient = {
        readResource: mock(() =>
          Promise.resolve({
            uri: 'file:///image.png',
            blob: 'base64encodeddata',
            mimeType: 'image/png',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await readMcpResourceTool.execute({ uri: 'file:///image.png' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('Binary content');
      expect(result.metadata?.hasBlob).toBe(true);
    });

    it('should filter by serverName when provided', async () => {
      const mockClient1 = {
        readResource: mock(() => Promise.resolve({ uri: 'test', text: 'from server1' })),
      };
      const mockClient2 = {
        readResource: mock(() => Promise.resolve({ uri: 'test', text: 'from server2' })),
      };
      mockGetAllServers.mockReturnValue(
        new Map([
          ['server1', { client: mockClient1 }],
          ['server2', { client: mockClient2 }],
        ])
      );

      const result = await readMcpResourceTool.execute({
        uri: 'file:///test.txt',
        serverName: 'server1',
      });

      expect(result.success).toBe(true);
      expect(mockClient1.readResource).toHaveBeenCalled();
      expect(mockClient2.readResource).not.toHaveBeenCalled();
    });

    it('should return error when resource not found', async () => {
      const mockClient = {
        readResource: mock(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await readMcpResourceTool.execute({ uri: 'file:///missing.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('not found');
    });

    it('should return error with serverName when specified server has no resource', async () => {
      const mockClient = {
        readResource: mock(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(new Map([['my-server', { client: mockClient }]]));

      const result = await readMcpResourceTool.execute({
        uri: 'file:///missing.txt',
        serverName: 'my-server',
      });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('my-server');
    });

    it('should skip servers without client', async () => {
      mockGetAllServers.mockReturnValue(new Map([['no-client-server', { client: null }]]));

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('not found');
    });

    it('should try next server on error', async () => {
      const mockClient1 = {
        readResource: mock(() => Promise.reject(new Error('Connection failed'))),
      };
      const mockClient2 = {
        readResource: mock(() => Promise.resolve({ uri: 'test', text: 'success' })),
      };
      mockGetAllServers.mockReturnValue(
        new Map([
          ['server1', { client: mockClient1 }],
          ['server2', { client: mockClient2 }],
        ])
      );

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('success');
    });

    it('should handle unexpected errors', async () => {
      mockGetAllServers.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('Failed to read MCP resource');
    });

    it('should handle resource with neither text nor blob', async () => {
      const mockClient = {
        readResource: mock(() =>
          Promise.resolve({
            uri: 'file:///test.txt',
            mimeType: 'application/octet-stream',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('uri');
    });
  });
});
