import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectToolExecution } from '../../../types/index.js';
import { createReadMcpResourceTool } from '../readMcpResource.js';
import type { McpRegistry } from '../../../../mcp/McpRegistry.js';

const mockGetAllServers = vi.fn(() => new Map());

const mockRegistry = {
  getAllServers: mockGetAllServers,
} as Pick<McpRegistry, 'getAllServers'> as McpRegistry;

const readMcpResourceTool = createReadMcpResourceTool(mockRegistry);
const executeReadMcpResource = (
  params: Parameters<typeof readMcpResourceTool.execute>[0],
) => collectToolExecution(readMcpResourceTool.execute(params));

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

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('error');
      expect(result.model).toBe('No MCP servers are currently connected.');
    });

    it('should read text resource successfully', async () => {
      const mockClient = {
        readResource: vi.fn(() =>
          Promise.resolve({
            uri: 'file:///test.txt',
            text: 'Hello, World!',
            mimeType: 'text/plain',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('success');
      expect(result.model).toBe('Hello, World!');
      expect(result.metadata?.hasText).toBe(true);
      expect(result.metadata?.contentLength).toBe(13);
    });

    it('should read blob resource successfully', async () => {
      const mockClient = {
        readResource: vi.fn(() =>
          Promise.resolve({
            uri: 'file:///image.png',
            blob: 'base64encodeddata',
            mimeType: 'image/png',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await executeReadMcpResource({ uri: 'file:///image.png' });

      expect(result.status).toBe('success');
      expect(result.model).toContain('Binary content');
      expect(result.metadata?.hasBlob).toBe(true);
    });

    it('should filter by serverName when provided', async () => {
      const mockClient1 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'from server1' })),
      };
      const mockClient2 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'from server2' })),
      };
      mockGetAllServers.mockReturnValue(
        new Map([
          ['server1', { client: mockClient1 }],
          ['server2', { client: mockClient2 }],
        ])
      );

      const result = await executeReadMcpResource({
        uri: 'file:///test.txt',
        serverName: 'server1',
      });

      expect(result.status).toBe('success');
      expect(mockClient1.readResource).toHaveBeenCalled();
      expect(mockClient2.readResource).not.toHaveBeenCalled();
    });

    it('should return error when resource not found', async () => {
      const mockClient = {
        readResource: vi.fn(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await executeReadMcpResource({ uri: 'file:///missing.txt' });

      expect(result.status).toBe('error');
      expect(result.model).toContain('not found');
    });

    it('should return error with serverName when specified server has no resource', async () => {
      const mockClient = {
        readResource: vi.fn(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(new Map([['my-server', { client: mockClient }]]));

      const result = await executeReadMcpResource({
        uri: 'file:///missing.txt',
        serverName: 'my-server',
      });

      expect(result.status).toBe('error');
      expect(result.model).toContain('my-server');
    });

    it('should skip servers without client', async () => {
      mockGetAllServers.mockReturnValue(new Map([['no-client-server', { client: null }]]));

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('error');
      expect(result.model).toContain('not found');
    });

    it('should try next server on error', async () => {
      const mockClient1 = {
        readResource: vi.fn(() => Promise.reject(new Error('Connection failed'))),
      };
      const mockClient2 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'success' })),
      };
      mockGetAllServers.mockReturnValue(
        new Map([
          ['server1', { client: mockClient1 }],
          ['server2', { client: mockClient2 }],
        ])
      );

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('success');
      expect(result.model).toBe('success');
    });

    it('should handle unexpected errors', async () => {
      mockGetAllServers.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('error');
      expect(result.model).toContain('Failed to read MCP resource');
    });

    it('should handle resource with neither text nor blob', async () => {
      const mockClient = {
        readResource: vi.fn(() =>
          Promise.resolve({
            uri: 'file:///test.txt',
            mimeType: 'application/octet-stream',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await executeReadMcpResource({ uri: 'file:///test.txt' });

      expect(result.status).toBe('success');
      expect(result.model).toContain('uri');
    });
  });
});
