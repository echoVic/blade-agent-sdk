import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createReadMcpResourceTool } from '../readMcpResource.js';
import type { McpRegistry } from '../../../../mcp/McpRegistry.js';

const mockGetAllServers = vi.fn<() => string[]>(() => []);
const mockGetServer = vi.fn<(name: string) => { client: unknown } | undefined>(() => undefined);

const mockRegistry = {
  getAllServers: mockGetAllServers,
  getServer: mockGetServer,
} as Pick<McpRegistry, 'getAllServers' | 'getServer'> as McpRegistry;

const readMcpResourceTool = createReadMcpResourceTool(mockRegistry);

describe('readMcpResourceTool', () => {
  beforeEach(() => {
    mockGetAllServers.mockClear();
    mockGetServer.mockClear();
  });

  afterEach(() => {
    mockGetAllServers.mockClear();
    mockGetServer.mockClear();
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
      mockGetAllServers.mockReturnValue([]);

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toBe('No MCP servers are currently connected.');
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
      mockGetAllServers.mockReturnValue(['test-server']);
      mockGetServer.mockReturnValue({ client: mockClient });

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('Hello, World!');
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
      mockGetAllServers.mockReturnValue(['test-server']);
      mockGetServer.mockReturnValue({ client: mockClient });

      const result = await readMcpResourceTool.execute({ uri: 'file:///image.png' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('Binary content');
      expect(result.metadata?.hasBlob).toBe(true);
    });

    it('should filter by serverName when provided', async () => {
      const mockClient1 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'from server1' })),
      };
      const mockClient2 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'from server2' })),
      };
      mockGetAllServers.mockReturnValue(['server1', 'server2']);
      mockGetServer.mockImplementation((name: string) =>
        name === 'server1' ? { client: mockClient1 } : { client: mockClient2 },
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
        readResource: vi.fn(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(['test-server']);
      mockGetServer.mockReturnValue({ client: mockClient });

      const result = await readMcpResourceTool.execute({ uri: 'file:///missing.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('not found');
    });

    it('should return error with serverName when specified server has no resource', async () => {
      const mockClient = {
        readResource: vi.fn(() => Promise.reject(new Error('Resource not found'))),
      };
      mockGetAllServers.mockReturnValue(['my-server']);
      mockGetServer.mockReturnValue({ client: mockClient });

      const result = await readMcpResourceTool.execute({
        uri: 'file:///missing.txt',
        serverName: 'my-server',
      });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('my-server');
    });

    it('should skip servers without client', async () => {
      mockGetAllServers.mockReturnValue(['no-client-server']);
      mockGetServer.mockReturnValue({ client: null });

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('not found');
    });

    it('should try next server on error', async () => {
      const mockClient1 = {
        readResource: vi.fn(() => Promise.reject(new Error('Connection failed'))),
      };
      const mockClient2 = {
        readResource: vi.fn(() => Promise.resolve({ uri: 'test', text: 'success' })),
      };
      mockGetAllServers.mockReturnValue(['server1', 'server2']);
      mockGetServer.mockImplementation((name: string) =>
        name === 'server1' ? { client: mockClient1 } : { client: mockClient2 },
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
        readResource: vi.fn(() =>
          Promise.resolve({
            uri: 'file:///test.txt',
            mimeType: 'application/octet-stream',
          })
        ),
      };
      mockGetAllServers.mockReturnValue(['test-server']);
      mockGetServer.mockReturnValue({ client: mockClient });

      const result = await readMcpResourceTool.execute({ uri: 'file:///test.txt' });

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('uri');
    });
  });
});
