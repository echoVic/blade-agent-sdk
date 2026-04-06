import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FileSystemMemoryStore,
  MemoryManager,
  SubagentExecutor,
  SubagentRegistry,
  ToolCatalog,
  createMemoryReadTool,
  createMemoryWriteTool,
} from '../index.js';
import type {
  RuntimePatch,
  ToolCatalogEntry,
  ToolEffect,
  ToolExecutionUpdate,
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
  });

  it('exports runtime tool contracts at the root entrypoint', () => {
    expectTypeOf<RuntimePatch['scope']>().toEqualTypeOf<'turn' | 'session'>();
    expectTypeOf<ToolEffect['type']>().toEqualTypeOf<
      'runtimePatch' | 'contextPatch' | 'newMessages' | 'permissionUpdates'
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
