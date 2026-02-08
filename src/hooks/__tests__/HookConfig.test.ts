import { describe, expect, it } from 'bun:test';
import { DEFAULT_HOOK_CONFIG, mergeHookConfig } from '../HookConfig.js';
import type { HookConfig } from '../types/HookTypes.js';
import { HookType } from '../types/HookTypes.js';

function createDefaultHookConfig(): HookConfig {
  return { ...DEFAULT_HOOK_CONFIG, enabled: true };
}

describe('HookConfig', () => {
  describe('createDefaultHookConfig', () => {
    it('should create config with enabled true by default', () => {
      const config = createDefaultHookConfig();
      expect(config.enabled).toBe(true);
    });

    it('should create config with default timeout', () => {
      const config = createDefaultHookConfig();
      expect(config.defaultTimeout).toBe(60);
    });

    it('should create config with ignore timeout behavior', () => {
      const config = createDefaultHookConfig();
      expect(config.timeoutBehavior).toBe('ignore');
    });

    it('should create config with ignore failure behavior', () => {
      const config = createDefaultHookConfig();
      expect(config.failureBehavior).toBe('ignore');
    });

    it('should create config with empty hook arrays', () => {
      const config = createDefaultHookConfig();
      expect(config.PreToolUse).toEqual([]);
      expect(config.PostToolUse).toEqual([]);
      expect(config.Stop).toEqual([]);
      expect(config.SessionStart).toEqual([]);
      expect(config.SessionEnd).toEqual([]);
    });

    it('should create config with new hook events', () => {
      const config = createDefaultHookConfig();
      expect(config.SubagentStart).toEqual([]);
      expect(config.SubagentStop).toEqual([]);
      expect(config.TaskCompleted).toEqual([]);
    });
  });

  describe('mergeHookConfig', () => {
    it('should override enabled setting', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = { enabled: false };
      const merged = mergeHookConfig(base, override);
      expect(merged.enabled).toBe(false);
    });

    it('should override timeout setting', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = { defaultTimeout: 120 };
      const merged = mergeHookConfig(base, override);
      expect(merged.defaultTimeout).toBe(120);
    });

    it('should override timeout behavior', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = { timeoutBehavior: 'deny' };
      const merged = mergeHookConfig(base, override);
      expect(merged.timeoutBehavior).toBe('deny');
    });

    it('should override failure behavior', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = { failureBehavior: 'ask' };
      const merged = mergeHookConfig(base, override);
      expect(merged.failureBehavior).toBe('ask');
    });

    it('should override PreToolUse hooks', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = {
        PreToolUse: [
          {
            matcher: { tools: 'Bash' },
            hooks: [{ type: HookType.Command, command: 'echo test' }],
          },
        ],
      };
      const merged = mergeHookConfig(base, override);
      expect(merged.PreToolUse).toHaveLength(1);
      expect(merged.PreToolUse![0].matcher?.tools).toBe('Bash');
    });

    it('should keep base values when override is undefined', () => {
      const base = createDefaultHookConfig();
      base.defaultTimeout = 90;
      const override: Partial<HookConfig> = { enabled: false };
      const merged = mergeHookConfig(base, override);
      expect(merged.defaultTimeout).toBe(90);
      expect(merged.enabled).toBe(false);
    });

    it('should handle empty override', () => {
      const base = createDefaultHookConfig();
      base.enabled = false;
      const merged = mergeHookConfig(base, {});
      expect(merged.enabled).toBe(false);
    });

    it('should override SubagentStart hooks', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = {
        SubagentStart: [
          {
            matcher: { tools: 'Explore' },
            hooks: [{ type: HookType.Command, command: 'echo agent start' }],
          },
        ],
      };
      const merged = mergeHookConfig(base, override);
      expect(merged.SubagentStart).toHaveLength(1);
    });

    it('should override TaskCompleted hooks', () => {
      const base = createDefaultHookConfig();
      const override: Partial<HookConfig> = {
        TaskCompleted: [
          {
            hooks: [{ type: HookType.Command, command: 'npm test' }],
          },
        ],
      };
      const merged = mergeHookConfig(base, override);
      expect(merged.TaskCompleted).toHaveLength(1);
    });
  });
});
