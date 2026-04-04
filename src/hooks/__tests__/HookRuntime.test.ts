import { describe, expect, it, vi } from 'vitest';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
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
});
