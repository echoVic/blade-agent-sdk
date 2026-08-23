import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolUseId, SessionId } from '../../types/branded.js';
import { PermissionMode } from '../../types/common.js';
import { DEFAULT_HOOK_CONFIG } from '../HookConfig.js';
import { HookManager } from '../HookManager.js';
import { SecureProcessExecutor } from '../SecureProcessExecutor.js';
import { HookType } from '../types/HookTypes.js';
import { HookProcessContainmentError } from '../WindowsProcessJob.js';

afterEach(() => {
  vi.restoreAllMocks();
  HookManager.getInstance().loadConfig(DEFAULT_HOOK_CONFIG);
});

describe('Hook infrastructure failures', () => {
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
});
