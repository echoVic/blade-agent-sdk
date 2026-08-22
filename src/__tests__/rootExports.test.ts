import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FileSystemMemoryStore,
  InputId,
  InputPriority,
  MemoryManager,
  RequestId,
  SessionInputError,
  SubagentExecutor,
  SubagentRegistry,
  ToolCatalog,
  ToolErrorType,
  collectToolExecution,
  completeToolExecution,
  createMemoryReadTool,
  createMemoryWriteTool,
} from '../index.js';
import type {
  InputSubmission,
  PendingSessionInput,
  RuntimePatch,
  ToolCatalogEntry,
  ToolEffect,
  ToolEffectYield,
  ToolExecution,
  ToolExecutionUpdate,
  ToolMessage,
  ToolProgress,
  ToolYield,
} from '../index.js';

describe('root exports', () => {
  it('exports the opt-in memory, catalog, and subagent primitives', () => {
    expect(MemoryManager).toBeDefined();
    expect(FileSystemMemoryStore).toBeDefined();
    expect(createMemoryReadTool).toBeDefined();
    expect(createMemoryWriteTool).toBeDefined();
    expect(SubagentRegistry).toBeDefined();
    expect(SubagentExecutor).toBeDefined();
    expect(ToolCatalog).toBeDefined();
    expect(collectToolExecution).toBeTypeOf('function');
    expect(completeToolExecution).toBeTypeOf('function');
    expect(InputPriority.NEXT).toBe('next');
    expect(InputId('input-1')).toBe('input-1');
    expect(RequestId('request-1')).toBe('request-1');
    expect(new SessionInputError('TEST', 'message')).toBeInstanceOf(Error);
    expect(ToolErrorType.INTERRUPTED).toBe('interrupted');
  });

  it('exports runtime tool contracts at the root entrypoint', () => {
    expectTypeOf<RuntimePatch['scope']>().toEqualTypeOf<'turn' | 'session'>();
    expectTypeOf<ToolEffect['type']>().toEqualTypeOf<
      'runtimePatch' | 'contextPatch' | 'newMessages' | 'permissionUpdates'
    >();
    expectTypeOf<ToolYield['kind']>().toEqualTypeOf<
      'progress' | 'message' | 'effect'
    >();
    expectTypeOf<ToolProgress['kind']>().toEqualTypeOf<'progress'>();
    expectTypeOf<ToolMessage['kind']>().toEqualTypeOf<'message'>();
    expectTypeOf<ToolEffectYield['kind']>().toEqualTypeOf<'effect'>();
    expectTypeOf<ToolExecution>().toMatchTypeOf<
      AsyncGenerator<ToolYield, unknown, void>
    >();
    expectTypeOf<InputSubmission['status']>().toEqualTypeOf<
      'started' | 'steered' | 'queued'
    >();
    expectTypeOf<PendingSessionInput['priority']>().toEqualTypeOf<
      'now' | 'next' | 'later'
    >();
    expectTypeOf<ToolCatalogEntry['source']['kind']>().toEqualTypeOf<
      'builtin' | 'custom' | 'mcp' | 'session'
    >();
    expectTypeOf<ToolExecutionUpdate['type']>().toEqualTypeOf<
      | 'tool_ready'
      | 'tool_started'
      | 'tool_progress'
      | 'tool_message'
      | 'tool_runtime_patch'
      | 'tool_context_patch'
      | 'tool_new_messages'
      | 'tool_permission_updates'
      | 'tool_result'
      | 'tool_completed'
    >();
  });
});
