import { describe, expect, expectTypeOf, it } from 'vitest';
import * as rootEntry from '../index.js';
import {
  SubagentExecutor,
  SubagentRegistry,
  ToolCatalog,
} from '../index.js';
import type {
  RuntimePatch,
  ToolCatalogEntry,
  ToolEffect,
  ToolExecutionUpdate,
} from '../index.js';

describe('root exports', () => {
  it('keeps local adapters behind the explicit local subpath', () => {
    expect(rootEntry).not.toHaveProperty('getBuiltinTools');
    expect(rootEntry).not.toHaveProperty('createSdkMcpServer');
    expect(rootEntry).not.toHaveProperty('FileSystemMemoryStore');
    expect(rootEntry).not.toHaveProperty('MemoryManager');
    expect(rootEntry).not.toHaveProperty('SandboxExecutor');
    expect(rootEntry).not.toHaveProperty('SandboxService');
  });

  it('exports the catalog and subagent primitives without local adapters', () => {
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
