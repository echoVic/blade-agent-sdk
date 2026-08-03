import { existsSync } from 'node:fs';
import { SessionId } from '../local/branded.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createTool,
  toolFromDefinition,
  ToolKind,
} from '../tools/index.js';

const toolRegistrationModulePath =
  '../session/runtimeToolRegistration.js';
const toolRegistrationSourcePath = 'src/session/runtimeToolRegistration.ts';

describe('agent-sdk package-local runtime tool registration helpers', () => {
  it('registers prebuilt tools directly while converting tool definitions', async () => {
    expect(existsSync(toolRegistrationSourcePath)).toBe(true);

    const { registerPackageLocalRuntimeCustomTools } = await import(toolRegistrationModulePath);
    const prebuiltTool = createTool({
      name: 'MemoryRead',
      displayName: 'Memory Read',
      kind: ToolKind.ReadOnly,
      schema: z.object({}),
      description: { short: 'Read memory' },
      execute: async () => ({ success: true, llmContent: 'memory' }),
    });
    const definition = {
      name: 'search_docs',
      description: 'Search docs',
      parameters: { type: 'object' as const },
      async execute() {
        return { success: true as const, llmContent: 'docs' };
      },
    };
    const fromDefinition = vi.fn(toolFromDefinition);
    const registerTools = vi.fn();

    registerPackageLocalRuntimeCustomTools({
      definitions: [prebuiltTool, definition],
      customToolFactory: { fromDefinition },
      registerTools,
    });

    expect(fromDefinition).toHaveBeenCalledOnce();
    expect(fromDefinition).toHaveBeenCalledWith(definition);
    expect(registerTools).toHaveBeenCalledWith(
      [prebuiltTool, expect.objectContaining({ name: 'search_docs' })],
      {
        kind: 'custom',
        trustLevel: 'workspace',
        sourceId: 'session',
      },
    );
  });

  it('does not require a custom tool factory for prebuilt tools', async () => {
    const { registerPackageLocalRuntimeCustomTools } = await import(toolRegistrationModulePath);
    const prebuiltTool = createTool({
      name: 'MemoryRead',
      displayName: 'Memory Read',
      kind: ToolKind.ReadOnly,
      schema: z.object({}),
      description: { short: 'Read memory' },
      execute: async () => ({ success: true, llmContent: 'memory' }),
    });
    const registerTools = vi.fn();

    registerPackageLocalRuntimeCustomTools({
      definitions: [prebuiltTool],
      registerTools,
    });

    expect(registerTools).toHaveBeenCalledWith(
      [prebuiltTool],
      {
        kind: 'custom',
        trustLevel: 'workspace',
        sourceId: 'session',
      },
    );
  });

  it('converts tool definitions even when they expose runtime-like helper methods', async () => {
    const { registerPackageLocalRuntimeCustomTools } = await import(toolRegistrationModulePath);
    const overlappingDefinition = {
      name: 'search_docs',
      description: 'Search docs',
      parameters: { type: 'object' as const },
      getFunctionDeclaration() {
        return { name: 'search_docs' };
      },
      build() {
        return {};
      },
      async execute() {
        return { success: true as const, llmContent: 'docs' };
      },
    };
    const fromDefinition = vi.fn(toolFromDefinition);
    const registerTools = vi.fn();

    registerPackageLocalRuntimeCustomTools({
      definitions: [overlappingDefinition],
      customToolFactory: { fromDefinition },
      registerTools,
    });

    expect(fromDefinition).toHaveBeenCalledWith(overlappingDefinition);
    expect(registerTools).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'search_docs' })],
      expect.objectContaining({ kind: 'custom' }),
    );
  });

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
      sessionId: SessionId('session-1'),
      storageRoot: '/tmp/blade',
      mcpRegistry,
      builtinToolProvider: {
        async getTools(context: unknown) {
          expect(context).toEqual({
            sessionId: SessionId('session-1'),
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
      sessionId: SessionId('session-1'),
      storageRoot: '/tmp/blade',
      mcpRegistry,
      builtinToolProvider: {
        async getTools(context: unknown) {
          expect(context).toEqual({
            sessionId: SessionId('session-1'),
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
