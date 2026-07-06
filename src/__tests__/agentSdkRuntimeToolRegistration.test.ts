import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const toolRegistrationModulePath =
  '../../packages/agent-sdk/src/session/runtimeToolRegistration.js';
const toolRegistrationSourcePath = 'packages/agent-sdk/src/session/runtimeToolRegistration.ts';

describe('agent-sdk package-local runtime tool registration helpers', () => {
  it('registers custom tools through factory and registration ports without runtime state', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { registerPackageLocalRuntimeCustomTools } = await import(toolRegistrationModulePath);
    const registered: unknown[] = [];
    const definitions = [
      {
        name: 'search_docs',
        description: 'Search docs',
        inputSchema: {},
      },
      {
        name: 'write_docs',
        description: 'Write docs',
        inputSchema: {},
      },
    ];

    registerPackageLocalRuntimeCustomTools({
      definitions,
      customToolFactory: {
        fromDefinition(definition: { name: string }) {
          return {
            name: `custom_${definition.name}`,
          };
        },
      },
      registerTools(tools: Array<{ name: string }>, source: unknown) {
        registered.push({ tools, source });
      },
    });

    expect(registered).toEqual([
      {
        tools: [{ name: 'custom_search_docs' }, { name: 'custom_write_docs' }],
        source: {
          kind: 'custom',
          trustLevel: 'workspace',
          sourceId: 'session',
        },
      },
    ]);
  });

  it('skips empty custom tool definitions and reports missing factories clearly', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { registerPackageLocalRuntimeCustomTools } = await import(toolRegistrationModulePath);
    const registered: unknown[] = [];

    registerPackageLocalRuntimeCustomTools({
      definitions: [],
      registerTools(tools: unknown[], source: unknown) {
        registered.push({ tools, source });
      },
    });

    expect(registered).toEqual([]);
    expect(() =>
      registerPackageLocalRuntimeCustomTools({
        definitions: [
          {
            name: 'search_docs',
            description: 'Search docs',
            inputSchema: {},
          },
        ],
        registerTools() {
          throw new Error('should not register');
        },
      }),
    ).toThrow('Package-local custom tool factory port is required to register tools');
  });

  it('registers builtin tools through provider and registration ports without runtime state', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { registerPackageLocalRuntimeBuiltinTools } = await import(toolRegistrationModulePath);
    const mcpRegistry = {};
    const registered: unknown[] = [];

    await registerPackageLocalRuntimeBuiltinTools({
      sessionId: 'session-1',
      storageRoot: '/tmp/blade',
      mcpRegistry,
      builtinToolProvider: {
        async getTools(context: unknown) {
          expect(context).toEqual({
            sessionId: 'session-1',
            configDir: '/tmp/blade',
            mcpRegistry,
            includeMcpProtocolTools: false,
          });
          return [{ name: 'read' }, { name: 'write' }];
        },
      },
      registerTools(tools: Array<{ name: string }>, source: unknown) {
        registered.push({ tools, source });
      },
    });

    expect(registered).toEqual([
      {
        tools: [{ name: 'read' }, { name: 'write' }],
        source: {
          kind: 'builtin',
          trustLevel: 'trusted',
          sourceId: 'builtin',
        },
      },
    ]);
  });

  it('creates reusable tool registration operations without session runtime state', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { createPackageLocalRuntimeToolRegistrationOperations } = await import(
      toolRegistrationModulePath
    );
    const source = {
      kind: 'session',
      trustLevel: 'workspace',
      sourceId: 'test',
    };
    const tools = [{ name: 'read' }, { name: 'write' }];
    const filteredTools = [{ name: 'read' }];
    const filterTools = vi.fn(() => filteredTools);
    const toolCatalog = {
      registerAll: vi.fn(),
    };

    const operations = createPackageLocalRuntimeToolRegistrationOperations({
      filterTools,
      toolCatalog,
    });

    operations.registerTools(tools, source);

    expect(filterTools).toHaveBeenCalledWith(tools);
    expect(toolCatalog.registerAll).toHaveBeenCalledWith(filteredTools, source);

    filterTools.mockReturnValueOnce([]);
    operations.registerTools(tools, source);

    expect(toolCatalog.registerAll).toHaveBeenCalledOnce();
  });

  it('bundles session custom and builtin tool registration behind injected ports', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { createPackageLocalRuntimeSessionToolRegistrationOperations } = await import(
      toolRegistrationModulePath
    );
    const mcpRegistry = {};
    const registered: unknown[] = [];

    const operations = createPackageLocalRuntimeSessionToolRegistrationOperations({
      definitions: [
        {
          name: 'search_docs',
          description: 'Search docs',
          inputSchema: {},
        },
      ],
      customToolFactory: {
        fromDefinition(definition: { name: string }) {
          return {
            name: `custom_${definition.name}`,
          };
        },
      },
      sessionId: 'session-1',
      storageRoot: '/tmp/blade',
      mcpRegistry,
      builtinToolProvider: {
        async getTools(context: unknown) {
          expect(context).toEqual({
            sessionId: 'session-1',
            configDir: '/tmp/blade',
            mcpRegistry,
            includeMcpProtocolTools: false,
          });
          return [{ name: 'read' }];
        },
      },
      registerTools(tools: Array<{ name: string }>, source: unknown) {
        registered.push({ tools, source });
      },
    });

    operations.registerCustomTools();
    await operations.registerBuiltinTools();

    expect(registered).toEqual([
      {
        tools: [{ name: 'custom_search_docs' }],
        source: {
          kind: 'custom',
          trustLevel: 'workspace',
          sourceId: 'session',
        },
      },
      {
        tools: [{ name: 'read' }],
        source: {
          kind: 'builtin',
          trustLevel: 'trusted',
          sourceId: 'builtin',
        },
      },
    ]);
  });
});
