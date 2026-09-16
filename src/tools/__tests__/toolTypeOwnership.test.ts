import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Type from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentOptions,
  AgentPlugin,
  SessionOptions,
  ToolDefinition,
  ToolDefinitionInput,
} from '../../index.js';
import { defineTool } from '../../index.js';
import type { JsonValue } from '../../types/json.js';
import type { ToolServiceMap, ToolServiceName } from '../services.js';
import type { RuntimeAccess } from '../types/execution.js';
import type { ErasedToolDefinition, Tool, ToolConfig } from '../types/tool.js';

describe('Tool type ownership', () => {
  it('accepts direct TypeBox schemas without a factory union', () => {
    const schema = Type.Object({ query: Type.String() });

    expectTypeOf<ToolConfig<typeof schema>['schema']>().toEqualTypeOf<typeof schema>();
  });

  it('infers authoring params from the TypeBox schema', () => {
    const schema = Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    });
    type Definition = ToolDefinitionInput<typeof schema, { found: boolean }>;
    type Params = Parameters<Definition['execute']>[0];

    expectTypeOf<Params>().toEqualTypeOf<{
      query: string;
      limit?: number;
    }>();
    expectTypeOf<ReturnType<Definition['execute']>>().toEqualTypeOf<Promise<{ found: boolean }>>();
  });

  it('preserves the TypeBox schema generic through defineTool', () => {
    const parameters = Type.Object({
      query: Type.String(),
    });
    const definition = defineTool({
      name: 'TypedDefinition',
      description: 'TypeBox input',
      parameters,
      async execute({ query }) {
        return { query };
      },
    });

    expectTypeOf(definition.parameters).toEqualTypeOf<typeof parameters>();
    expectTypeOf<Parameters<typeof definition.execute>[0]>().toEqualTypeOf<{
      query: string;
    }>();
  });

  it('exposes only declared services and runtime capabilities to execute', () => {
    defineTool({
      name: 'PrivilegedDefinition',
      description: 'Checks authoring context inference',
      parameters: Type.Object({}),
      services: ['subagentRegistry'] as const,
      requiresRuntime: true,
      async execute(_params, context) {
        expectTypeOf(context.subagentRegistry).toEqualTypeOf<ToolServiceMap['subagentRegistry']>();
        expectTypeOf(context.runtime).toEqualTypeOf<RuntimeAccess>();
        // @ts-expect-error memoryManager was not declared.
        context.memoryManager;
        // @ts-expect-error registry access is internal to the execution pipeline.
        context.toolRegistry;
        return {};
      },
    });

    defineTool({
      name: 'OrdinaryDefinition',
      description: 'Does not request runtime access',
      parameters: Type.Object({}),
      async execute(_params, context) {
        // @ts-expect-error runtime requires an explicit declaration.
        context.runtime;
        return {};
      },
    });
  });

  it('owns heterogeneous definition erasure in the Tool module', () => {
    const sessionTypes = readFileSync(resolve('src/session/types.ts'), 'utf8');
    const toolTypes = readFileSync(resolve('src/tools/types/tool.ts'), 'utf8');
    type SessionDefinition = NonNullable<SessionOptions['tools']>[number];
    type AgentDefinition = NonNullable<AgentOptions['tools']>[number];
    type PluginDefinition = NonNullable<AgentPlugin['tools']>[number];
    type PublicToolDefinition = ToolDefinition<Type.TSchema, JsonValue, ToolServiceName, boolean>;

    expectTypeOf<ErasedToolDefinition>().toHaveProperty('execute');
    expectTypeOf<SessionDefinition>().toEqualTypeOf<PublicToolDefinition>();
    expectTypeOf<AgentDefinition>().toEqualTypeOf<PublicToolDefinition>();
    expectTypeOf<PluginDefinition>().toEqualTypeOf<PublicToolDefinition>();
    const runtimeToolAcceptance: [
      Tool extends SessionDefinition ? true : false,
      Tool extends AgentDefinition ? true : false,
      Tool extends PluginDefinition ? true : false,
    ] = [false, false, false];
    expect(runtimeToolAcceptance).toEqual([false, false, false]);
    expect(toolTypes).toContain('export type ErasedToolDefinition');
    expect(sessionTypes).toContain('ToolDefinition<Type.TSchema');
    expect(sessionTypes).not.toMatch(/\bErasedToolDefinition\b/);
    expect(sessionTypes).not.toMatch(/\bSessionTool\b/);
    expect(sessionTypes).not.toContain('ToolDefinition<never>');
    for (const entrypoint of [
      'src/index.ts',
      'src/browser/index.ts',
      'src/core/index.ts',
      'src/tools/index.ts',
    ]) {
      expect(readFileSync(resolve(entrypoint), 'utf8')).not.toMatch(/\bErasedToolDefinition\b/);
    }
  });

  it('does not recover runtime tools through structural detection', () => {
    for (const entrypoint of [
      'src/index.ts',
      'src/session/index.ts',
      'src/agent/createAgent.ts',
      'src/middleware/AgentPlugin.ts',
    ]) {
      const source = readFileSync(resolve(entrypoint), 'utf8');
      expect(source).not.toMatch(/\bSessionTool\b/);
      expect(source).not.toMatch(/\bisRuntimeTool\b/);
      expect(source).not.toMatch(/\bErasedToolDefinition\b/);
    }
    for (const runtimeModule of ['src/middleware/PluginHost.ts', 'src/session/SessionRuntime.ts']) {
      const source = readFileSync(resolve(runtimeModule), 'utf8');
      expect(source).not.toMatch(/\bSessionTool\b/);
      expect(source).not.toMatch(/\bisRuntimeTool\b/);
    }
  });

  it('does not expose schema-family or codec-specific Tool contracts', () => {
    const toolTypes = readFileSync(resolve('src/tools/types/tool.ts'), 'utf8');
    const publicEntrypoints = [
      'src/index.ts',
      'src/core/index.ts',
      'src/tools/index.ts',
      'src/tools/types/index.ts',
    ].map((entrypoint) => readFileSync(resolve(entrypoint), 'utf8'));

    for (const source of [toolTypes, ...publicEntrypoints]) {
      expect(source).not.toMatch(/\bZodToolDefinitionInput\b/);
      expect(source).not.toMatch(/\bJsonSchemaToolDefinitionInput\b/);
      expect(source).not.toMatch(/\bcodec\b/i);
    }
    expect(toolTypes).not.toMatch(/from ['"]zod['"]/);
    expect(toolTypes).toMatch(/Type\.Static/);
  });

  it('keeps legacy and runtime-only tool contracts out of the root entrypoint', () => {
    const publicAuthoringEntrypoints = [
      'src/index.ts',
      'src/core/index.ts',
      'src/tools/index.ts',
    ].map((entrypoint) => readFileSync(resolve(entrypoint), 'utf8'));

    for (const source of publicAuthoringEntrypoints) {
      expect(source).not.toMatch(/export\s*\{[^}]*\bcreateTool\b/s);
      expect(source).not.toMatch(/export\s*\{[^}]*\btoolFromDefinition\b/s);
      expect(source).not.toMatch(/\bToolConfig\b/);
      expect(source).not.toMatch(/\bFunctionDeclaration\b/);
      expect(source).not.toMatch(/^\s*Tool,\s*$/m);
      expect(source).not.toMatch(/\bToolDescriptionResolver\b/);
      expect(source).not.toMatch(/\bToolSchema\b/);
    }
  });

  it('keeps TypeBox compilation and erasure boundaries free of ad hoc casts', () => {
    const createToolSource = readFileSync(resolve('src/tools/core/createTool.ts'), 'utf8');
    const toolInputSource = readFileSync(resolve('src/tools/validation/toolInput.ts'), 'utf8');
    const sources = [
      'src/tools/core/createTool.ts',
      'src/mcp/createMcpTool.ts',
      'src/mcp/SdkMcpServer.ts',
      'src/session/SessionRuntime.ts',
      'src/tools/builtin/memory/memoryRead.ts',
      'src/tools/builtin/memory/memoryWrite.ts',
      'src/tools/validation/toolInput.ts',
    ].map((file) => readFileSync(resolve(file), 'utf8'));
    const combined = sources.join('\n');

    expect(combined).not.toMatch(/parameters as JSONSchema7/);
    expect(combined).not.toMatch(/params as JsonObject/);
    expect(combined).not.toMatch(/inputSchema as Type\.TUnsafe/);
    expect(combined).not.toMatch(/definition\.schema as \{/);
    expect(combined).not.toMatch(/const candidate = tool as \{/);
    expect(combined).not.toMatch(/params as \{ operation: string \}/);
    expect(combined).not.toMatch(/schema as \(\) => TSchema/);
    expect(combined).not.toMatch(/current as Record<string, unknown>/);
    expect(createToolSource).not.toMatch(/\bisToolResult\b/);
    expect(createToolSource).not.toMatch(/\bisAsyncGenerator\b/);
    expect(createToolSource).toContain('function executeErasedDefinition');
    expect(createToolSource.match(/\[params, context\] as never/g)).toHaveLength(1);
    expect(createToolSource.match(/\bas JSONSchema7\b/g)).toHaveLength(1);
    expect(toolInputSource.match(/\bas CompiledToolInput<TSchema>/g)).toHaveLength(1);
  });
});
