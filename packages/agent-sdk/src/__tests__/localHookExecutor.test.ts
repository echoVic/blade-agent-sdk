import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import { HookExecutor } from '../local/HookExecutor.js';
import { HookType, type CommandHook, type HookExecutionContext, type StopInput } from '../local/hookTypes.js';

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
        sessionId: SessionId('session-1') as any,
        permissionMode: 'default',
        config: {
          timeoutBehavior: 'ignore',
          failureBehavior: 'ignore',
        } as any,
      },
    );

    expect(result.decision).toBe('allow');
  });
});

describe('HookExecutor stop hooks (agent-sdk)', () => {
  function mockProcessExecutor(executor: HookExecutor, stdout: string): void {
    (executor as unknown as { processExecutor: unknown }).processExecutor = {
      execute: async () => ({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        success: true,
      }),
    };
  }

  const stopHook: CommandHook = {
    type: HookType.Command,
    command: 'echo test',
    timeout: 1,
  };

  const stopInput: StopInput = {
    hook_event_name: 'Stop' as const,
    hook_execution_id: 'exec-1',
    timestamp: new Date().toISOString(),
    project_dir: '/test',
    session_id: 'session-1',
    permission_mode: 'default',
    reason: 'done',
  };

  const execContext: HookExecutionContext = {
    projectDir: '/test',
    sessionId: SessionId('session-1') as unknown as HookExecutionContext['sessionId'],
    permissionMode: 'default',
    config: {
      timeoutBehavior: 'ignore',
      failureBehavior: 'ignore',
      maxConcurrentHooks: 5,
    },
  };

  it('allows stopping when no hook blocks it', async () => {
    const executor = new HookExecutor();
    mockProcessExecutor(executor, '');

    const result = await executor.executeStopHooks([stopHook], stopInput, execContext);
    expect(result.shouldStop).toBe(true);
  });

  it('blocks stopping when a hook returns continue: false', async () => {
    const executor = new HookExecutor();
    mockProcessExecutor(
      executor,
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', continue: false, continueReason: 'busy' } }),
    );

    const result = await executor.executeStopHooks([stopHook], stopInput, execContext);
    expect(result.shouldStop).toBe(false);
    expect(result.continueReason).toBe('busy');
  });
});
