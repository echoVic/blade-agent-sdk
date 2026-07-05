import { describe, expect, it, vi } from 'vitest';
import { initializePackageLocalRuntimeHooks } from '../../packages/agent-sdk/src/session/runtimeHooks.js';
import type { PackageLocalRuntimeHookManagerPort } from '../../packages/agent-sdk/src/session/runtimeHooks.js';
import { HookEvent } from '../../packages/agent-sdk/src/types/constants.js';

function hookManager(): PackageLocalRuntimeHookManagerPort {
  return {
    enable: vi.fn(),
  };
}

describe('agent-sdk package-local runtime hook helpers', () => {
  it('does not enable the hook manager when no hooks are configured', () => {
    const manager = hookManager();

    initializePackageLocalRuntimeHooks({
      hookManager: manager,
      hooks: undefined,
    });

    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('enables the hook manager when hooks are configured', () => {
    const manager = hookManager();

    initializePackageLocalRuntimeHooks({
      hookManager: manager,
      hooks: {
        [HookEvent.UserPromptSubmit]: [async () => ({ action: 'continue' })],
      },
    });

    expect(manager.enable).toHaveBeenCalledTimes(1);
  });
});
