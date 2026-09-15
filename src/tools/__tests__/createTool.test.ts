import Type from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createTool, defineTool, toolFromDefinition } from '../core/createTool.js';
import { ToolKind } from '../types/kind.js';
import type { ReadMetadata } from '../types/metadata.js';
import {
  collectToolExecution,
  completeToolExecution,
  type ToolResult,
  type ToolYield,
} from '../types/result.js';
import { lazySchema } from '../validation/lazySchema.js';

describe('createTool', () => {
  describe('TypeBox contract', () => {
    it('uses the authored schema directly for declarations and metadata', () => {
      const parameters = Type.Object({
        message: Type.String({ description: 'Message to echo' }),
      });
      const tool = createTool({
        name: 'TypeBoxEcho',
        displayName: 'TypeBox Echo',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Echo a message' },
        schema: parameters,
        execute: ({ message }) =>
          completeToolExecution({
            status: 'success',
            model: message,
          }),
      });

      expect(tool.getFunctionDeclaration().parameters).toBe(parameters);
      expect(tool.getMetadata().schema).toBe(parameters);
    });

    it('applies TypeBox defaults before callbacks receive params', async () => {
      const tool = createTool({
        name: 'TypeBoxDefaults',
        displayName: 'TypeBox Defaults',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Apply defaults' },
        schema: Type.Object({
          message: Type.String(),
          count: Type.Optional(Type.Number({ default: 2 })),
        }),
        execute: ({ message, count }) =>
          completeToolExecution({
            status: 'success',
            model: Array(count).fill(message).join(' '),
          }),
      });

      const result = await collectToolExecution(tool.execute({ message: 'hello' }));

      expect(result.model).toBe('hello hello');
    });

    it('rejects invalid TypeBox params before any Tool callback runs', () => {
      let callbackCount = 0;
      const tool = createTool({
        name: 'TypeBoxValidation',
        displayName: 'TypeBox Validation',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Validate input' },
        schema: Type.Object({
          count: Type.Integer({ minimum: 1 }),
        }),
        describe: () => {
          callbackCount += 1;
          return { short: 'Validated invocation' };
        },
        execute: () => {
          callbackCount += 1;
          return completeToolExecution({ status: 'success', model: 'ok' });
        },
      });

      expect(() => tool.build({ count: 0 })).toThrow(/参数验证失败/);
      expect(callbackCount).toBe(0);
    });

    it('validates defineTool params with the same TypeBox runtime path', () => {
      let executionCount = 0;
      const definition = defineTool({
        name: 'DefinedTypeBoxTool',
        description: 'TypeBox definition',
        parameters: Type.Object({
          query: Type.String({ minLength: 1 }),
        }),
        async execute({ query }) {
          executionCount += 1;
          return { query };
        },
      });
      const tool = toolFromDefinition(definition);

      expect(tool.getFunctionDeclaration().parameters).toBe(definition.parameters);
      expect(() => tool.build({ query: '' })).toThrow(/参数验证失败/);
      expect(executionCount).toBe(0);
    });
  });

  it('exposes ToolResult as a status-discriminated generic union', () => {
    type EchoResult = ToolResult<{ echoed: string }, ReadMetadata>;

    expectTypeOf<EchoResult>().toMatchTypeOf<
      | {
          status: 'success';
          data?: { echoed: string };
          metadata?: ReadMetadata;
        }
      | {
          status: 'error';
          error: {
            message: string;
          };
        }
    >();
  });

  const testSchema = Type.Object({
    message: Type.String({ description: 'The message to echo' }),
    count: Type.Optional(Type.Number({ description: 'Number of times to repeat' })),
  });

  const echoTool = createTool({
    name: 'Echo',
    displayName: 'Echo Tool',
    kind: ToolKind.ReadOnly,
    sideEffect: 'pure',
    description: {
      short: 'Echoes a message',
      long: 'A simple tool that echoes back the provided message',
      usageNotes: ['Use for testing', 'Supports repetition'],
      important: ['Do not use in production'],
    },
    schema: testSchema,
    async *execute(params) {
      const count = params.count || 1;
      const result = Array(count).fill(params.message).join(' ');
      yield {
        kind: 'progress',
        message: 'Echoing message',
        data: { count },
      };
      return { status: 'success', model: result };
    },
  });

  describe('tool properties', () => {
    it('rejects a missing side-effect contract at runtime for createTool', () => {
      expect(() =>
        createTool({
          name: 'MissingSideEffect',
          displayName: 'Missing Side Effect',
          kind: ToolKind.ReadOnly,
          description: { short: 'Invalid tool' },
          schema: Type.Object({}),
          execute: () => completeToolExecution({ status: 'success', model: '' }),
        } as never),
      ).toThrow(/sideEffect must be/);
    });

    it('rejects an unknown side-effect value at runtime', () => {
      expect(() =>
        createTool({
          name: 'BadSideEffect',
          displayName: 'Bad Side Effect',
          kind: ToolKind.ReadOnly,
          sideEffect: 'sometimes' as never,
          description: { short: 'Invalid tool' },
          schema: Type.Object({}),
          execute: () => completeToolExecution({ status: 'success', model: '' }),
        }),
      ).toThrow(/sideEffect must be/);
    });

    it('should have correct name', () => {
      expect(echoTool.name).toBe('Echo');
    });

    it('should have correct displayName', () => {
      expect(echoTool.displayName).toBe('Echo Tool');
    });

    it('should have correct kind', () => {
      expect(echoTool.kind).toBe(ToolKind.ReadOnly);
    });

    it('should expose the declared side-effect contract', () => {
      expect(echoTool.sideEffect).toBe('pure');
    });

    it('should be readonly for readonly kind', () => {
      expect(echoTool.isReadOnly).toBe(true);
    });

    it('should be concurrency safe by default', () => {
      expect(echoTool.isConcurrencySafe).toBe(true);
    });

    it('should not be strict by default', () => {
      expect(echoTool.strict).toBe(false);
    });

    it('should default maxResultSizeChars to infinity', () => {
      expect(echoTool.maxResultSizeChars).toBe(Number.POSITIVE_INFINITY);
    });

    it('should default interruptBehavior to block', () => {
      expect(echoTool.interruptBehavior).toBe('block');
    });

    it('should resolve default behavior from static config', () => {
      expect(echoTool.resolveBehavior?.({ message: 'Hello' })).toEqual({
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'block',
      });
    });
  });

  describe('getFunctionDeclaration', () => {
    it('should return function declaration with name', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.name).toBe('Echo');
    });

    it('should include short description', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Echoes a message');
    });

    it('should include long description', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('echoes back the provided message');
    });

    it('should include usage notes', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Usage Notes:');
      expect(declaration.description).toContain('Use for testing');
    });

    it('should include important notes', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Important:');
      expect(declaration.description).toContain('Do not use in production');
    });

    it('should have parameters schema', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.parameters).toBeDefined();
      expect(declaration.parameters.type).toBe('object');
    });

    it('should support lazy schemas without rebuilding them on repeated access', () => {
      let schemaInitCount = 0;
      const lazyTool = createTool({
        name: 'LazyTool',
        displayName: 'Lazy Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Lazy tool' },
        schema: lazySchema(() => {
          schemaInitCount += 1;
          return Type.Object({
            value: Type.String(),
          });
        }),
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      });

      expect(schemaInitCount).toBe(0);

      lazyTool.getFunctionDeclaration();
      lazyTool.getMetadata();
      lazyTool.build({ value: 'hello' });

      expect(schemaInitCount).toBe(1);
    });

    it('should use dynamic descriptions for concrete invocations while preserving static declarations', () => {
      const describedTool = createTool({
        name: 'DescribeTool',
        displayName: 'Describe Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'General tool description' },
        describe: (params) => ({
          short: params?.target ? `Inspect target: ${params.target}` : 'General tool description',
        }),
        schema: Type.Object({
          target: Type.String(),
        }),
        execute: ({ target }) =>
          completeToolExecution({
            status: 'success',
            model: target,
          }),
      });

      expect(describedTool.getFunctionDeclaration().description).toContain(
        'General tool description',
      );
      expect(describedTool.describe({ target: '/tmp/demo.txt' }).short).toBe(
        'Inspect target: /tmp/demo.txt',
      );
      expect(describedTool.build({ target: '/tmp/demo.txt' }).getDescription()).toBe(
        'Inspect target: /tmp/demo.txt',
      );
    });
  });

  describe('getMetadata', () => {
    it('should return complete metadata', () => {
      const metadata = echoTool.getMetadata();
      expect(metadata.name).toBe('Echo');
      expect(metadata.displayName).toBe('Echo Tool');
      expect(metadata.kind).toBe(ToolKind.ReadOnly);
      expect(metadata.sideEffect).toBe('pure');
      expect(metadata.version).toBe('1.0.0');
    });

    it('should include schema', () => {
      const metadata = echoTool.getMetadata();
      expect(metadata.schema).toBeDefined();
    });
  });

  describe('build', () => {
    it('should create tool invocation with valid params', () => {
      const invocation = echoTool.build({ message: 'Hello' });
      expect(invocation).toBeDefined();
    });

    it('infers affected file paths from common path-shaped params', () => {
      const pathTool = createTool({
        name: 'PathTool',
        displayName: 'Path Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Path-aware tool' },
        schema: Type.Object({
          file_path: Type.String(),
          backupPath: Type.Optional(Type.String()),
          files: Type.Optional(Type.Array(Type.String())),
        }),
        execute: ({ file_path }) =>
          completeToolExecution({
            status: 'success',
            model: file_path,
          }),
      });

      const invocation = pathTool.build({
        file_path: '/tmp/example.txt',
        backupPath: '/tmp/example.bak',
        files: ['/tmp/one.txt', '/tmp/two.txt'],
      });

      expect(invocation.getAffectedPaths()).toEqual([
        '/tmp/example.txt',
        '/tmp/example.bak',
        '/tmp/one.txt',
        '/tmp/two.txt',
      ]);
    });

    it('should throw on invalid params', () => {
      expect(() => {
        echoTool.build({ message: 123 } as unknown as Type.Static<typeof testSchema>);
      }).toThrow();
    });
  });

  describe('execute', () => {
    it('should execute with valid params', async () => {
      const events: ToolYield[] = [];
      const result = await collectToolExecution(echoTool.execute({ message: 'Hello' }), (event) => {
        events.push(event);
      });
      expect(result.status).toBe('success');
      expect(result.model).toBe('Hello');
      expect(events).toEqual([
        {
          kind: 'progress',
          message: 'Echoing message',
          data: { count: 1 },
        },
      ]);
    });

    it('should handle count parameter', async () => {
      const result = await collectToolExecution(echoTool.execute({ message: 'Hi', count: 3 }));
      expect(result.status).toBe('success');
      expect(result.model).toBe('Hi Hi Hi');
    });

    it('should run semantic validateInput before execution', async () => {
      const guardedTool = createTool({
        name: 'GuardedTool',
        displayName: 'Guarded Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Tool with semantic validation' },
        schema: Type.Object({
          value: Type.String(),
        }),
        validateInput: ({ value }) =>
          value === 'blocked'
            ? {
                message: 'Blocked by semantic validation',
              }
            : undefined,
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      });

      const blocked = await collectToolExecution(guardedTool.execute({ value: 'blocked' }));
      const allowed = await collectToolExecution(guardedTool.execute({ value: 'allowed' }));

      expect(blocked.status).toBe('error');
      expect(blocked.error?.message).toBe('Blocked by semantic validation');
      expect(allowed.status).toBe('success');
      expect(allowed.model).toBe('allowed');
    });

    it('closes the execution when an event consumer fails', async () => {
      let finalized = false;
      const tool = createTool({
        name: 'CleanupTool',
        displayName: 'Cleanup Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Tool with cleanup' },
        schema: Type.Object({}),
        async *execute() {
          try {
            yield { kind: 'progress', message: 'started' };
            return { status: 'success', model: 'done' };
          } finally {
            finalized = true;
          }
        },
      });

      await expect(
        collectToolExecution(tool.execute({}), () => {
          throw new Error('consumer failed');
        }),
      ).rejects.toThrow('consumer failed');
      expect(finalized).toBe(true);
    });

    it('preserves consumer failures when execution cleanup also fails', async () => {
      const tool = createTool({
        name: 'FailingCleanupTool',
        displayName: 'Failing Cleanup Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Tool with failing cleanup' },
        schema: Type.Object({}),
        async *execute() {
          try {
            yield { kind: 'progress', message: 'started' };
            return { status: 'success', model: 'done' };
          } finally {
            // biome-ignore lint/correctness/noUnsafeFinally: verifies cleanup-error precedence
            throw new Error('cleanup failed');
          }
        },
      });

      await expect(
        collectToolExecution(tool.execute({}), () => {
          throw new Error('consumer failed');
        }),
      ).rejects.toThrow('consumer failed');
    });

    it('rejects Promise-returning tool implementations at runtime', async () => {
      const invalidTool = createTool({
        name: 'InvalidTool',
        displayName: 'Invalid Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Invalid legacy tool' },
        schema: Type.Object({}),
        execute: (async () => ({
          status: 'success',
          model: 'legacy result',
        })) as never,
      });

      await expect(collectToolExecution(invalidTool.execute({}))).rejects.toMatchObject({
        name: 'ToolExecutionError',
        code: 'TOOL_EXECUTION_ERROR',
        toolName: 'InvalidTool',
      });
    });

    it('rejects Promise-returning definitions through the direct tool API', async () => {
      const invalidTool = toolFromDefinition({
        name: 'InvalidDefinition',
        sideEffect: 'pure',
        description: 'Invalid legacy tool definition',
        parameters: Type.Object({}),
        execute: (async () => ({
          status: 'success',
          model: 'legacy result',
        })) as never,
      });

      await expect(collectToolExecution(invalidTool.execute({}))).rejects.toMatchObject({
        name: 'ToolExecutionError',
        code: 'TOOL_EXECUTION_ERROR',
        toolName: 'InvalidDefinition',
      });
    });

    it('should expose tool-level checkPermissions when configured', async () => {
      const guardedTool = createTool({
        name: 'PermissionedTool',
        displayName: 'Permissioned Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Tool with permission check' },
        schema: Type.Object({
          value: Type.String(),
        }),
        checkPermissions: ({ value }) =>
          value === 'blocked'
            ? {
                behavior: 'deny',
                message: 'Blocked by tool permission',
              }
            : undefined,
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      });

      const blocked = await guardedTool.checkPermissions?.({ value: 'blocked' }, {} as never);
      const allowed = await guardedTool.checkPermissions?.({ value: 'allowed' }, {} as never);

      expect(blocked).toEqual({
        behavior: 'deny',
        message: 'Blocked by tool permission',
      });
      expect(allowed).toBeUndefined();
    });
  });

  describe('tool kind inference', () => {
    it('should infer isReadOnly from kind', () => {
      const readonlyTool = createTool({
        name: 'ReadTool',
        displayName: 'Read Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Read only tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });
      expect(readonlyTool.isReadOnly).toBe(true);

      const writeTool = createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Write tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });
      expect(writeTool.isReadOnly).toBe(false);
    });

    it('should allow explicit isReadOnly override', () => {
      const tool = createTool({
        name: 'CustomTool',
        displayName: 'Custom Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        isReadOnly: false,
        description: { short: 'Custom tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });
      expect(tool.isReadOnly).toBe(false);
    });

    it('should resolve dynamic behavior from validated params', () => {
      const tool = createTool({
        name: 'DynamicTool',
        displayName: 'Dynamic Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Dynamic behavior tool' },
        schema: Type.Object({
          mode: Type.Enum(['read', 'write'], { default: 'read' }),
        }),
        resolveBehavior: (params) => ({
          kind: params.mode === 'read' ? ToolKind.ReadOnly : ToolKind.Write,
          sideEffect: params.mode === 'read' ? 'pure' : 'idempotent',
          isReadOnly: params.mode === 'read',
          isConcurrencySafe: params.mode === 'read',
          isDestructive: params.mode !== 'read',
        }),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });

      expect(tool.resolveBehavior?.({} as unknown as { mode: 'read' | 'write' })).toEqual({
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'block',
      });
      expect(tool.resolveBehavior?.({ mode: 'write' })).toEqual({
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: true,
        interruptBehavior: 'block',
      });
    });

    it('should preserve explicit maxResultSizeChars overrides', () => {
      const tool = createTool({
        name: 'LimitedTool',
        displayName: 'Limited Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Limited tool' },
        schema: Type.Object({}),
        maxResultSizeChars: 128,
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });

      expect(tool.maxResultSizeChars).toBe(128);
    });

    it('should preserve explicit interruptBehavior overrides', () => {
      const tool = createTool({
        name: 'BlockingTool',
        displayName: 'Blocking Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Blocking tool' },
        schema: Type.Object({}),
        interruptBehavior: 'block',
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });

      expect(tool.interruptBehavior).toBe('block');
      expect(tool.resolveBehavior?.({})).toMatchObject({
        interruptBehavior: 'block',
      });
    });
  });

  describe('permission matcher preparation', () => {
    it('should support preparePermissionMatcher', () => {
      const toolWithSignature = createTool({
        name: 'SignatureTool',
        displayName: 'Signature Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Tool with signature' },
        schema: Type.Object({ path: Type.String() }),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
        preparePermissionMatcher: (params) => ({
          signatureContent: params.path,
          abstractRule: `read:${params.path}`,
        }),
      });

      expect(toolWithSignature.preparePermissionMatcher).toBeDefined();
      expect(toolWithSignature.preparePermissionMatcher?.({ path: '/test/file.ts' })).toEqual({
        signatureContent: '/test/file.ts',
        abstractRule: 'read:/test/file.ts',
      });
    });
  });

  describe('toolFromDefinition', () => {
    it('preserves category, tags, and exposure metadata for simplified tool definitions', () => {
      const tool = toolFromDefinition({
        name: 'IndexedTool',
        sideEffect: 'pure',
        description: 'Indexed tool',
        parameters: { type: 'object', properties: {} },
        category: 'analysis',
        tags: ['search', 'catalog'],
        exposure: {
          mode: 'deferred',
          discoveryHint: 'Use when searching the tool catalog.',
        },
        execute() {
          return completeToolExecution({
            status: 'success',
            model: 'ok',
          });
        },
      });

      expect(tool.category).toBe('analysis');
      expect(tool.tags).toEqual(['search', 'catalog']);
      expect(tool.exposure).toMatchObject({
        mode: 'deferred',
        discoveryHint: 'Use when searching the tool catalog.',
      });
      expect(tool.getMetadata()).toMatchObject({
        category: 'analysis',
        sideEffect: 'pure',
        tags: ['search', 'catalog'],
      });
    });

    it('treats a missing sideEffect as non-idempotent instead of rejecting the definition', () => {
      expect(
        defineTool({
          name: 'Unlabelled',
          description: 'No side effect declared',
          parameters: Type.Object({}),
          execute() {
            return completeToolExecution({ status: 'success', model: 'ok' });
          },
        }).sideEffect,
      ).toBeUndefined();

      const tool = toolFromDefinition({
        name: 'Unlabelled',
        description: 'No side effect declared',
        parameters: Type.Object({}),
        execute() {
          return completeToolExecution({ status: 'success', model: 'ok' });
        },
      });

      expect(tool.sideEffect).toBe('non_idempotent');
      expect(tool.getBehaviorHint?.()).toMatchObject({ sideEffect: 'non_idempotent' });
    });

    it('accepts a TypeBox schema and validates parameters against it', async () => {
      const parameters = Type.Object({ query: Type.String() });
      const tool = toolFromDefinition({
        name: 'TypeBoxTool',
        description: 'Declared with TypeBox',
        parameters,
        execute(params) {
          return completeToolExecution({ status: 'success', model: `query=${params.query}` });
        },
      });

      expect(tool.getFunctionDeclaration().parameters).toMatchObject({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      });

      const accepted = await collectToolExecution(tool.execute({ query: 'blade' }));
      expect(accepted).toMatchObject({ status: 'success', model: 'query=blade' });

      expect(() => tool.execute({ query: 42 })).toThrow(/query/);
    });

    it('wraps an async defineTool callback as a generator-backed execution', async () => {
      const definition = defineTool({
        name: 'AsyncWeather',
        description: 'Get weather for a city',
        parameters: Type.Object({ city: Type.String() }),
        async execute({ city }) {
          expectTypeOf(city).toEqualTypeOf<string>();
          return {
            status: 'success',
            model: `${city}: clear`,
          };
        },
      });
      const tool = toolFromDefinition(definition);

      await expect(collectToolExecution(tool.execute({ city: 'Tokyo' }))).resolves.toMatchObject({
        status: 'success',
        model: 'Tokyo: clear',
      });
    });

    it('wraps a plain async return value as a successful tool result', async () => {
      const definition = defineTool({
        name: 'SimpleWeather',
        description: 'Get weather for a city',
        parameters: Type.Object({ city: Type.String() }),
        async execute({ city }) {
          return { weather: `${city}: clear` };
        },
      });
      const tool = toolFromDefinition(definition);

      await expect(collectToolExecution(tool.execute({ city: 'Tokyo' }))).resolves.toEqual({
        status: 'success',
        model: { weather: 'Tokyo: clear' },
        data: { weather: 'Tokyo: clear' },
      });
    });

    it('validates every TypeBox definition before execution', () => {
      const tool = toolFromDefinition({
        name: 'ValidatedDefinition',
        description: 'Declared with TypeBox',
        parameters: Type.Object({
          message: Type.String(),
        }),
        execute(params) {
          return completeToolExecution({
            status: 'success',
            model: `message=${String(params.message)}`,
          });
        },
      });

      expect(() => tool.build({ message: 7 })).toThrow(/参数验证失败/);
    });
  });
});
