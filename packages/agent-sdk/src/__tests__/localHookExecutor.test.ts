import { describe, expect, it } from 'vitest';
import { HookExecutor } from '../local/HookExecutor.js';

describe('HookExecutor (agent-sdk)', () => {
  it('can be instantiated', () => {
    const executor = new HookExecutor();
    expect(executor).toBeInstanceOf(HookExecutor);
  });

  it('returns allow decision when no hooks provided for pre-tool execution', async () => {
    const executor = new HookExecutor();
    const result = await executor.executePreToolHooks(
      [],
      {
        hook_event_name: 'PreToolUse' as any,
        hook_execution_id: 'exec-1',
        timestamp: new Date().toISOString(),
        project_dir: '/test',
        session_id: 'session-1',
        permission_mode: 'default',
        tool_name: 'TestTool',
        tool_use_id: 'tu-1',
        tool_input: {},
      },
      {
        projectDir: '/test',
        sessionId: 'session-1' as any,
        permissionMode: 'default',
        config: {
          timeoutBehavior: 'warn',
          failureBehavior: 'warn',
        } as any,
      },
    );

    expect(result.decision).toBe('allow');
  });
});
