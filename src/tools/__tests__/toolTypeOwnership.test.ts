import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JSONSchema7 } from 'json-schema';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type {
  JsonSchemaToolDefinitionInput,
  ToolDefinition,
  ToolDefinitionInput,
  ZodToolDefinitionInput,
} from '../../index.js';
import { defineTool } from '../../index.js';
import type { ErasedToolDefinition } from '../types/tool.js';

describe('Tool type ownership', () => {
  it('infers Zod authoring params from the schema', () => {
    const schema = z.object({
      query: z.string(),
      limit: z.number().optional(),
    });
    type Definition = ZodToolDefinitionInput<typeof schema>;
    type Params = Parameters<Definition['execute']>[0];

    expectTypeOf<Params>().toEqualTypeOf<{
      query: string;
      limit?: number;
    }>();
  });

  it('keeps an explicit JSON Schema authoring path', () => {
    type Params = { query: string };
    type Definition = JsonSchemaToolDefinitionInput<Params>;

    expectTypeOf<Definition['parameters']>().toEqualTypeOf<JSONSchema7>();
    expectTypeOf<Parameters<Definition['execute']>[0]>().toEqualTypeOf<Params>();
  });

  it('keeps generic ToolDefinitionInput variables callable during migration', () => {
    const definition: ToolDefinitionInput<{ query: string }> = {
      name: 'LegacyTypedDefinition',
      description: 'Compatibility input',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      async execute({ query }) {
        return { query };
      },
    };

    expectTypeOf(defineTool(definition)).toEqualTypeOf<
      ToolDefinition<{ query: string }>
    >();
  });

  it('owns heterogeneous definition erasure in the Tool module', () => {
    const sessionTypes = readFileSync(resolve('src/session/types.ts'), 'utf8');
    const toolTypes = readFileSync(resolve('src/tools/types/tool.ts'), 'utf8');

    expectTypeOf<ErasedToolDefinition>().toHaveProperty('execute');
    expect(toolTypes).toContain('export type ErasedToolDefinition');
    expect(sessionTypes).toContain('SessionTool = ErasedToolDefinition | Tool');
    expect(sessionTypes).not.toContain('ToolDefinition<never>');
    for (const entrypoint of [
      'src/index.ts',
      'src/browser/index.ts',
      'src/core/index.ts',
      'src/tools/index.ts',
    ]) {
      expect(readFileSync(resolve(entrypoint), 'utf8')).not.toMatch(
        /\bErasedToolDefinition\b/,
      );
    }
  });
});
