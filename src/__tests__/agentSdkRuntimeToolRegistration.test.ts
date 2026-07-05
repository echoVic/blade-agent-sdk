import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
});
