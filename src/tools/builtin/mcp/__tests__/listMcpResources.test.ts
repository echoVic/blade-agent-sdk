import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createListMcpResourcesTool } from '../listMcpResources.js';

const mockGetAllServers = mock(() => new Map());

const mockRegistry = {
  getAllServers: mockGetAllServers,
} as any;

const listMcpResourcesTool = createListMcpResourcesTool(mockRegistry);

describe('listMcpResourcesTool', () => {
  beforeEach(() => {
    mockGetAllServers.mockClear();
  });

  afterEach(() => {
    mockGetAllServers.mockClear();
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(listMcpResourcesTool.name).toBe('ListMcpResources');
    });

    it('should have correct displayName', () => {
      expect(listMcpResourcesTool.displayName).toBe('List MCP Resources');
    });
  });

  describe('execute', () => {
    it('should return no servers message when no servers connected', async () => {
      mockGetAllServers.mockReturnValue(new Map());

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('No MCP servers are currently connected.');
      expect(result.metadata?.serverCount).toBe(0);
    });

    it('should return no resources message when servers have no resources', async () => {
      const mockClient = {
        listResources: mock(() => Promise.resolve([])),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('No resources found');
    });

    it('should list resources from all servers', async () => {
      const mockClient = {
        listResources: mock(() =>
          Promise.resolve([
            { uri: 'file:///test.txt', name: 'Test File', description: 'A test file' },
            { uri: 'db://users/1', name: 'User 1', mimeType: 'application/json' },
          ])
        ),
      };
      mockGetAllServers.mockReturnValue(new Map([['test-server', { client: mockClient }]]));

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('Found 2 resource(s)');
      expect(result.llmContent).toContain('file:///test.txt');
      expect(result.llmContent).toContain('db://users/1');
      expect(result.metadata?.resourceCount).toBe(2);
    });

    it('should filter by serverName when provided', async () => {
      const mockClient1 = {
        listResources: mock(() => Promise.resolve([{ uri: 'file:///test1.txt', name: 'Test 1' }])),
      };
      const mockClient2 = {
        listResources: mock(() => Promise.resolve([{ uri: 'file:///test2.txt', name: 'Test 2' }])),
      };
      mockGetAllServers.mockReturnValue(
        new Map([
          ['server1', { client: mockClient1 }],
          ['server2', { client: mockClient2 }],
        ])
      );

      const result = await listMcpResourcesTool.execute({ serverName: 'server1' });

      expect(result.success).toBe(true);
      expect(mockClient1.listResources).toHaveBeenCalled();
      expect(mockClient2.listResources).not.toHaveBeenCalled();
    });

    it('should skip servers without client', async () => {
      mockGetAllServers.mockReturnValue(new Map([['no-client-server', { client: null }]]));

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('No resources found');
    });

    it('should handle errors from individual servers', async () => {
      const mockClient = {
        listResources: mock(() => Promise.reject(new Error('Connection failed'))),
      };
      mockGetAllServers.mockReturnValue(new Map([['failing-server', { client: mockClient }]]));

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(true);
      expect(result.metadata?.errors).toBeDefined();
    });

    it('should handle unexpected errors', async () => {
      mockGetAllServers.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await listMcpResourcesTool.execute({});

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('Failed to list MCP resources');
    });
  });
});
