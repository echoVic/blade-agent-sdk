import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeToolsModulePath = '../../packages/agent-sdk/src/session/runtimeTools.js';
const runtimeToolsSourcePath = 'packages/agent-sdk/src/session/runtimeTools.ts';

describe('agent-sdk package-local runtime tool operations', () => {
  it('bundles filter, catalog registration, and session registration behind injected ports', async () => {
    expect(existsSync(runtimeToolsSourcePath)).toBe(true);

    const { createPackageLocalRuntimeToolOperations } = await import(runtimeToolsModulePath);
    const mcpRegistry = {};
    const registered: unknown[] = [];
    const catalogCalls: unknown[] = [];

    const operations = createPackageLocalRuntimeToolOperations({
      allowedTools: ['read', 'custom_search_docs'],
      disallowedTools: ['write'],
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
          return [{ name: 'read' }, { name: 'write' }];
        },
      },
      toolCatalog: {
        registerAll(tools: Array<{ name: string }>, source: unknown) {
          catalogCalls.push({ tools, source });
        },
      },
      registerTools(tools: Array<{ name: string }>, source: unknown) {
        registered.push({ tools, source });
      },
    });

    expect(
      operations.filter.filter([{ name: 'read' }, { name: 'write' }, { name: 'search' }]),
    ).toEqual([{ name: 'read' }]);

    operations.registration.registerTools(
      [{ name: 'read' }, { name: 'write' }],
      {
        kind: 'builtin',
        trustLevel: 'trusted',
        sourceId: 'builtin',
      },
    );
    operations.sessionRegistration.registerCustomTools();
    await operations.sessionRegistration.registerBuiltinTools();

    expect(catalogCalls).toEqual([
      {
        tools: [{ name: 'read' }],
        source: {
          kind: 'builtin',
          trustLevel: 'trusted',
          sourceId: 'builtin',
        },
      },
    ]);
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
        tools: [{ name: 'read' }, { name: 'write' }],
        source: {
          kind: 'builtin',
          trustLevel: 'trusted',
          sourceId: 'builtin',
        },
      },
    ]);
  });
});
