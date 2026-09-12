import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processInlineCommands } from '../SkillLoader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-inline-'));
  roots.push(root);
  return root;
}

describe('inline command cancellation', () => {
  it('stops a running command when the Session signal aborts', async () => {
    const root = await tempDir();
    const marker = join(root, 'survived');
    const controller = new AbortController();

    // The command writes a marker only if it keeps running for a while.
    const pending = processInlineCommands(
      `!\`sleep 3 && echo yes > ${marker}\``,
      root,
      { signal: controller.signal },
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = Date.now();
    controller.abort(new Error('turn cancelled'));
    await pending;

    // The command did not run to completion, so the marker was never written.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
    // And the abort took effect promptly rather than waiting out the sleep.
    expect(Date.now() - before).toBeLessThan(2_500);
  }, 15_000);

  it('does not start a command when the signal is already aborted', async () => {
    const root = await tempDir();
    const marker = join(root, 'never');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await processInlineCommands(
      `!\`echo yes > ${marker}\``,
      root,
      { signal: controller.signal },
    );

    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
    expect(result).toContain('cancelled');
  });
});
