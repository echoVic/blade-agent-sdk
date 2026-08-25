import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../types/constants.js';
import { SessionId, ToolUseId } from '../../types/identifiers.js';
import { DEFAULT_HOOK_CONFIG } from '../HookConfig.js';
import { HookExecutor } from '../HookExecutor.js';
import { HookManager } from '../HookManager.js';
import { SecureProcessExecutor } from '../SecureProcessExecutor.js';
import { HookType } from '../types.js';
import {
  HookProcessContainmentError,
  isHookProcessContainmentError,
  WindowsProcessJob,
} from '../WindowsProcessJob.js';

const roots: string[] = [];

function createWindowsJob(bindings: Record<string, unknown>): WindowsProcessJob {
  const Constructor = WindowsProcessJob as unknown as new (
    bindings: Record<string, unknown>,
    handle: object,
  ) => WindowsProcessJob;
  return new Constructor(bindings, {});
}

afterEach(async () => {
  vi.restoreAllMocks();
  HookManager.getInstance().loadConfig(DEFAULT_HOOK_CONFIG);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Hook infrastructure failures', () => {
  it('recognizes containment failures through aggregate and cause wrappers', () => {
    const containmentError = new HookProcessContainmentError('Windows Job Object cleanup failed');
    const aggregate = new AggregateError([
      new Error('durable settlement failed'),
      new Error('wrapped', { cause: containmentError }),
    ]);

    expect(isHookProcessContainmentError(aggregate)).toBe(true);
    expect(isHookProcessContainmentError(new Error('ordinary failure'))).toBe(false);
  });

  it('does not downgrade a process-containment failure to ignore', async () => {
    const containmentError = new HookProcessContainmentError(
      'Windows Job Object support is unavailable',
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(SecureProcessExecutor.prototype, 'execute').mockRejectedValue(containmentError);
    const manager = HookManager.getInstance();
    manager.loadConfig({
      ...DEFAULT_HOOK_CONFIG,
      enabled: true,
      failureBehavior: 'ignore',
      PreToolUse: [
        {
          hooks: [{ type: HookType.Command, command: 'echo guarded' }],
        },
      ],
    });

    await expect(
      manager.executePreToolHooks(
        'Bash',
        ToolUseId('containment-failure'),
        {},
        {
          projectDir: process.cwd(),
          sessionId: SessionId('containment-failure'),
          permissionMode: PermissionMode.DEFAULT,
        },
      ),
    ).rejects.toBe(containmentError);
  });

  it('keeps ordinary Hook failures recoverable under ignore policy', async () => {
    vi.spyOn(SecureProcessExecutor.prototype, 'execute').mockRejectedValue(
      new Error('hook command failed'),
    );
    const manager = HookManager.getInstance();
    manager.loadConfig({
      ...DEFAULT_HOOK_CONFIG,
      enabled: true,
      failureBehavior: 'ignore',
      PreToolUse: [
        {
          hooks: [{ type: HookType.Command, command: 'echo optional' }],
        },
      ],
    });

    await expect(
      manager.executePreToolHooks(
        'Bash',
        ToolUseId('recoverable-hook-failure'),
        {},
        {
          projectDir: process.cwd(),
          sessionId: SessionId('recoverable-hook-failure'),
          permissionMode: PermissionMode.DEFAULT,
        },
      ),
    ).resolves.toMatchObject({
      decision: 'allow',
      warning: 'hook command failed',
    });
  });

  it('propagates containment failure from a ConfigChange Hook reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-config-reload-'));
    roots.push(root);
    const configPath = join(root, 'settings.json');
    await writeFile(
      configPath,
      JSON.stringify({
        hooks: { enabled: true },
      }),
    );
    const containmentError = new HookProcessContainmentError(
      'Windows Job Object support is unavailable',
    );
    const manager = HookManager.getInstance();
    vi.spyOn(manager, 'executeConfigChangeHooks').mockRejectedValueOnce(containmentError);

    await expect(manager.reloadConfig(configPath)).rejects.toBe(containmentError);
  });

  it('stops scheduling concurrent Hooks after a containment failure', async () => {
    const containmentError = new HookProcessContainmentError('Windows Job Object cleanup failed');
    const execute = vi
      .spyOn(SecureProcessExecutor.prototype, 'execute')
      .mockRejectedValueOnce(containmentError)
      .mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
    const executor = new HookExecutor();

    await expect(
      executor.executePostToolHooks(
        [
          { type: HookType.Command, command: 'first' },
          { type: HookType.Command, command: 'second' },
        ],
        {
          hook_event_name: 'PostToolUse',
          hook_execution_id: 'containment-concurrency',
          timestamp: new Date().toISOString(),
          project_dir: process.cwd(),
          session_id: 'containment-concurrency',
          permission_mode: PermissionMode.DEFAULT,
          tool_name: 'Bash',
          tool_use_id: 'containment-concurrency',
          tool_input: {},
          tool_response: {
            status: 'success',
            model: 'ok',
          },
        },
        {
          projectDir: process.cwd(),
          sessionId: SessionId('containment-concurrency'),
          permissionMode: PermissionMode.DEFAULT,
          config: {
            ...DEFAULT_HOOK_CONFIG,
            enabled: true,
            maxConcurrentHooks: 1,
          },
        },
      ),
    ).rejects.toBe(containmentError);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('bounds Windows Job termination and closes the kill-on-close handle', async () => {
    const closeHandle = vi.fn(() => 1);
    const job = createWindowsJob({
      queryInformationJobObject: vi.fn((_job, _informationClass, information: Buffer) => {
        information.writeUInt32LE(1, 40);
        return 1;
      }),
      terminateJobObject: vi.fn(() => 1),
      closeHandle,
      getLastError: vi.fn(() => 0),
    });

    await expect(job.terminateAndWait(1)).rejects.toMatchObject({
      code: 'HOOK_PROCESS_CONTAINMENT_FAILED',
    });
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it('reports a native process-handle close failure during assignment', () => {
    const processHandle = {};
    const job = createWindowsJob({
      openProcess: vi.fn(() => processHandle),
      assignProcessToJobObject: vi.fn(() => 1),
      closeHandle: vi.fn(() => 0),
      getLastError: vi.fn(() => 6),
    });

    expect(() => job.assign(42_424)).toThrow('Failed to close the Windows Hook process handle');
  });
});
