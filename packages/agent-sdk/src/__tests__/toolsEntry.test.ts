import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as toolsEntry from '../tools/index.js';
import {
  ToolCatalog,
  ToolKind,
  createToolBehavior,
  createTool,
  defineTool,
  toolFromDefinition,
} from '../tools/index.js';

describe('agent-sdk tools entry', () => {
  it('exports package-owned validation result normalization', () => {
    expect(toolsEntry).toHaveProperty('validationErrorToToolResult');
  });

  it('exports package-owned tool behavior helpers', () => {
    expect(createToolBehavior).toBeTypeOf('function');
    expect(createToolBehavior(ToolKind.ReadOnly)).toMatchObject({
      kind: ToolKind.ReadOnly,
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    for (const helper of [
      'getStaticToolBehavior',
      'isReadOnlyKind',
      'resolveToolBehavior',
      'resolveToolBehaviorHint',
      'resolveToolBehaviorSafely',
    ]) {
      expect(toolsEntry, helper).toHaveProperty(helper);
    }
  });

  it('creates executable tools from package-local authoring helpers', async () => {
    const tool = createTool({
      name: 'Echo',
      displayName: 'Echo',
      kind: ToolKind.ReadOnly,
      description: {
        short: 'Echoes a message',
        long: 'Returns the message untouched.',
      },
      schema: z.object({
        message: z.string().describe('Message to echo'),
        path: z.string().optional(),
      }),
      execute: async ({ message }) => ({
        success: true,
        llmContent: message,
      }),
    });

    expect(tool.isReadOnly).toBe(true);
    expect(tool.getFunctionDeclaration()).toMatchObject({
      name: 'Echo',
      description: expect.stringContaining('Returns the message untouched.'),
      parameters: {
        type: 'object',
      },
    });
    expect(tool.build({ message: 'hello', path: '/tmp/a.txt' }).getAffectedPaths()).toEqual([
      '/tmp/a.txt',
    ]);
    await expect(tool.execute({ message: 'hello' })).resolves.toMatchObject({
      success: true,
      llmContent: 'hello',
    });
  });

  it('keeps catalog source metadata and search package-local', () => {
    const catalog = new ToolCatalog();
    const readTool = createTool({
      name: 'Read',
      displayName: 'Read',
      kind: ToolKind.ReadOnly,
      description: { short: 'Read files' },
      schema: z.object({ path: z.string() }),
      execute: async () => ({ success: true, llmContent: '' }),
    });
    const writeTool = createTool({
      name: 'Write',
      displayName: 'Write',
      kind: ToolKind.Write,
      description: { short: 'Write files' },
      schema: z.object({ path: z.string() }),
      execute: async () => ({ success: true, llmContent: '' }),
    });

    catalog.register(readTool, {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });
    catalog.register(writeTool, {
      kind: 'custom',
      trustLevel: 'workspace',
      sourceId: 'session',
    });

    expect(catalog.getAll().map((entry) => entry.name)).toEqual(['Read', 'Write']);
    expect(catalog.getEntry('Read')?.source).toEqual({
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });
    expect(catalog.search('write').map((entry) => entry.name)).toEqual(['Write']);
    expect(catalog.getFunctionDeclarationsByMode().map((entry) => entry.name)).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('round-trips simplified tool definitions', async () => {
    const definition = defineTool({
      name: 'DefinedTool',
      description: 'Defined tool',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      async execute(params: { value: string }) {
        return {
          success: true,
          llmContent: params.value,
        };
      },
    });
    const tool = toolFromDefinition(definition);

    expect(tool.getFunctionDeclaration()).toMatchObject({
      name: 'DefinedTool',
      parameters: definition.parameters,
    });
    await expect(tool.execute({ value: 'ok' })).resolves.toMatchObject({
      success: true,
      llmContent: 'ok',
    });
  });
});
