import { describe, expect, it, vi } from 'vitest';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import { HookRuntime } from '../HookRuntime.js';

describe('HookRuntime', () => {
  it('computes image metadata once per applyUserPromptSubmit stage', async () => {
    const hookManager = {
      executeUserPromptSubmitHooks: vi.fn(async () => ({ proceed: true })),
    };
    const runtime = new HookRuntime({
      sessionId: 'session-1',
      permissionMode: PermissionMode.DEFAULT,
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async () => ({ action: 'continue' }),
        ],
      },
      resolveProjectDir: () => '/tmp/project',
      hookManager: hookManager as never,
    });

    const getImageCountSpy = vi.spyOn(
      runtime as unknown as { getImageCount: (message: string | ContentPart[]) => number },
      'getImageCount',
    );

    await runtime.applyUserPromptSubmit([
      { type: 'text', text: 'prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,1' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,2' } },
    ]);

    expect(getImageCountSpy).toHaveBeenCalledTimes(2);
    expect(hookManager.executeUserPromptSubmitHooks).toHaveBeenCalledWith(
      'prompt',
      expect.objectContaining({
        hasImages: true,
        imageCount: 2,
      }),
    );
  });

  it('replaces all text parts with one leading text part while preserving all images', async () => {
    const runtime = new HookRuntime({
      sessionId: 'session-2',
      permissionMode: PermissionMode.DEFAULT,
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async () => ({
            action: 'continue',
            modifiedInput: 'updated prompt',
          }),
        ],
      },
      resolveProjectDir: () => undefined,
      hookManager: {
        executeUserPromptSubmitHooks: vi.fn(),
      } as never,
    });

    const rewritten = await runtime.applyUserPromptSubmit([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,before' } },
      { type: 'text', text: 'first chunk' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,after-first' } },
      { type: 'text', text: 'second chunk' },
    ] satisfies ContentPart[]);

    expect(rewritten).toEqual([
      { type: 'text', text: 'updated prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,before' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,after-first' } },
    ]);
  });

  it('merges callback and hook-manager pre/post tool hooks through one facade', async () => {
    const hookManager = {
      executePreToolHooks: vi.fn(async () => ({
        decision: 'ask',
        reason: 'manager confirmation',
        modifiedInput: { manager: true },
      })),
      executePostToolHooks: vi.fn(async () => ({
        additionalContext: 'manager context',
      })),
    };
    const runtime = new HookRuntime({
      sessionId: 'session-tool-hooks',
      permissionMode: PermissionMode.DEFAULT,
      callbacks: {
        [HookEvent.PreToolUse]: [
          async () => ({
            action: 'continue',
            modifiedInput: { callback: true },
          }),
        ],
        [HookEvent.PostToolUse]: [
          async () => ({
            action: 'continue',
            modifiedOutput: 'callback output',
          }),
        ],
      },
      resolveProjectDir: () => '/tmp/project',
      hookManager: hookManager as never,
    });

    const pre = await runtime.applyPreToolUse('Read', { file_path: 'a.ts' }, {
      toolUseId: 'tool-1',
    });

    const result: ToolResult = {
      success: true,
      llmContent: 'original output',
    };
    const post = await runtime.applyPostToolUse('Read', pre.updatedInput, result, {
      toolUseId: 'tool-1',
    });

    expect(pre.updatedInput).toEqual({
      file_path: 'a.ts',
      callback: true,
      manager: true,
    });
    expect(pre.needsConfirmation).toBe(true);
    expect(pre.reason).toBe('manager confirmation');
    expect(hookManager.executePreToolHooks).toHaveBeenCalledWith(
      'Read',
      'tool-1',
      expect.objectContaining({
        callback: true,
      }),
      expect.objectContaining({
        projectDir: '/tmp/project',
      }),
    );
    expect(post.result.llmContent).toBe('callback output');
    expect(hookManager.executePostToolHooks).toHaveBeenCalledWith(
      'Read',
      'tool-1',
      expect.objectContaining({
        manager: true,
      }),
      expect.objectContaining({
        llmContent: 'original output',
      }),
      expect.objectContaining({
        projectDir: '/tmp/project',
      }),
    );
  });
});
