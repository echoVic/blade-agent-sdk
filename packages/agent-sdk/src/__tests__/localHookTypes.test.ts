import { describe, expect, it } from 'vitest';
import {
  // Types
  type HookInputBase,
  type PreToolUseInput,
  type PostToolUseInput,
  type HookOutput,
  type PreToolHookResult,
  type PostToolHookResult,
  type StopHookResult,
  // Values
  DecisionBehavior,
  // Schemas
  getHookSchemas,
  safeParseHookOutput,
} from '../local/index.js';

describe('Hook Types exports', () => {
  it('exports hook input type members at the type level', () => {
    const base: HookInputBase = {
      hook_event_name: 'PreToolUse' as HookInputBase['hook_event_name'],
      hook_execution_id: 'exec-1',
      timestamp: new Date().toISOString(),
      project_dir: '/test',
      session_id: 'session-1',
      permission_mode: 'default',
    };
    expect(base.hook_event_name).toBe('PreToolUse');
    expect(base.session_id).toBe('session-1');
  });

  it('extends PreToolUseInput from HookInputBase', () => {
    const input: PreToolUseInput = {
      hook_event_name: 'PreToolUse' as PreToolUseInput['hook_event_name'],
      hook_execution_id: 'exec-1',
      timestamp: new Date().toISOString(),
      project_dir: '/test',
      session_id: 'session-1',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_use_id: 'toolu_001',
      tool_input: { command: 'ls' },
    };
    expect(input.tool_name).toBe('Bash');
    expect(input.tool_input.command).toBe('ls');
  });

  it('produces shape-compatible PostToolUseInput', () => {
    const input: PostToolUseInput = {
      hook_event_name: 'PostToolUse' as PostToolUseInput['hook_event_name'],
      hook_execution_id: 'exec-2',
      timestamp: new Date().toISOString(),
      project_dir: '/test',
      session_id: 'session-1',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_use_id: 'toolu_002',
      tool_input: { file_path: '/tmp/test.txt' },
      tool_response: {
        success: true,
        llmContent: 'file content',
      },
    };
    expect(input.tool_response.success).toBe(true);
  });

  it('produces shape-compatible HookOutput', () => {
    const output: HookOutput = {
      suppressOutput: true,
      systemMessage: 'test',
      decision: { behavior: DecisionBehavior.Approve },
    };
    expect(output.suppressOutput).toBe(true);
    expect(output.systemMessage).toBe('test');
  });

  it('produces shape-compatible PreToolHookResult', () => {
    const result: PreToolHookResult = {
      decision: 'allow',
      reason: 'approved by policy',
    };
    expect(result.decision).toBe('allow');
  });

  it('produces shape-compatible PostToolHookResult', () => {
    const result: PostToolHookResult = {
      additionalContext: 'context string',
      warning: 'caution',
    };
    expect(result.additionalContext).toBe('context string');
    expect(result.warning).toBe('caution');
  });

  it('produces shape-compatible StopHookResult', () => {
    const result: StopHookResult = {
      shouldStop: true,
    };
    expect(result.shouldStop).toBe(true);
  });
});

describe('Hook Schemas exports', () => {
  it('getHookSchemas returns a lazy bundle of schemas', () => {
    const schemas = getHookSchemas();
    expect(schemas).toBeDefined();
    expect(schemas.HookInputBaseSchema).toBeDefined();
    expect(schemas.HookOutputSchema).toBeDefined();
    expect(schemas.PreToolUseInputSchema).toBeDefined();
    expect(schemas.PostToolUseInputSchema).toBeDefined();
  });

  it('HookInputBaseSchema validates a minimal valid input', () => {
    const schemas = getHookSchemas();
    const result = schemas.HookInputBaseSchema.safeParse({
      hook_event_name: 'PreToolUse',
      hook_execution_id: 'exec-1',
      timestamp: new Date().toISOString(),
      project_dir: '/test',
      session_id: 'session-1',
      permission_mode: 'default',
      _metadata: { blade_version: '1.0.0', hook_timeout_ms: 30000 },
    });
    expect(result.success).toBe(true);
  });

  it('PreToolUseInputSchema validates a complete PreToolUse input', () => {
    const schemas = getHookSchemas();
    const result = schemas.PreToolUseInputSchema.safeParse({
      hook_event_name: 'PreToolUse',
      hook_execution_id: 'exec-1',
      timestamp: new Date().toISOString(),
      project_dir: '/test',
      session_id: 'session-1',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_use_id: 'toolu_001',
      tool_input: { command: 'ls' },
    });
    expect(result.success).toBe(true);
  });

  it('safeParseHookOutput validates a valid output', () => {
    const result = safeParseHookOutput({
      suppressOutput: true,
      systemMessage: 'test message',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suppressOutput).toBe(true);
      expect(result.data.systemMessage).toBe('test message');
    }
  });

  it('safeParseHookOutput rejects invalid output', () => {
    // Provide wrong type for a known field
    const result = safeParseHookOutput({ decision: 'not-an-object' });
    expect(result.success).toBe(false);
  });
});
