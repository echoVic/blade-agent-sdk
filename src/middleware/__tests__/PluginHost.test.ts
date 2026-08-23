import { describe, expect, it, vi } from 'vitest';
import { HookEvent } from '../../types/constants.js';
import type { AgentPlugin } from '../AgentPlugin.js';
import { PluginHost } from '../PluginHost.js';

describe('PluginHost', () => {
  it('keeps direct middleware outermost and preserves plugin order', () => {
    const directModel = {};
    const directTool = vi.fn();
    const firstModel = {};
    const firstTool = vi.fn();
    const secondTool = vi.fn();
    const plugins: AgentPlugin[] = [
      {
        name: 'first',
        middleware: {
          model: [firstModel],
          tool: [firstTool],
        },
      },
      {
        name: 'second',
        middleware: {
          tool: [secondTool],
        },
      },
    ];

    const host = new PluginHost({
      middleware: {
        model: [directModel],
        tool: [directTool],
      },
      plugins,
    });

    expect(host.getModelMiddleware()).toEqual([directModel, firstModel]);
    expect(host.getToolMiddleware()).toEqual([directTool, firstTool, secondTool]);
  });

  it('merges session hooks before plugin hooks', async () => {
    const calls: string[] = [];
    const sessionHook = vi.fn(async () => {
      calls.push('session');
      return { action: 'continue' as const };
    });
    const pluginHook = vi.fn(async () => {
      calls.push('plugin');
      return { action: 'continue' as const };
    });
    const host = new PluginHost({
      plugins: [
        {
          name: 'hooks',
          hooks: {
            [HookEvent.UserPromptSubmit]: [pluginHook],
          },
        },
      ],
    });

    const merged = host.mergeHooks({
      [HookEvent.UserPromptSubmit]: [sessionHook],
    });
    const hooks = merged[HookEvent.UserPromptSubmit] ?? [];
    for (const hook of hooks) {
      await hook({
        event: HookEvent.UserPromptSubmit,
        sessionId: 'session' as never,
      });
    }

    expect(calls).toEqual(['session', 'plugin']);
  });

  it('rejects empty and duplicate plugin names', () => {
    expect(() => new PluginHost({ plugins: [{ name: '' }] })).toThrow(
      'must not be empty',
    );
    expect(
      () =>
        new PluginHost({
          plugins: [{ name: 'audit' }, { name: 'audit' }],
        }),
    ).toThrow('registered more than once');
  });
});
