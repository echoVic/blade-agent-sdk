import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelServiceConfig } from '../../model/config.js';

const mockSideQuery = vi.fn(async (..._args: unknown[]) => ({
  content: '<summary>ok</summary>',
}));
const mockCreateModelService = vi.fn(async (config: ModelServiceConfig) => {
  let currentConfig = config;
  return {
    async chat() {
      return { content: 'unused' };
    },
    sideQuery: mockSideQuery,
    async *streamChat() {
      yield { content: 'unused' };
    },
    getConfig() {
      return currentConfig;
    },
    updateConfig(next: Partial<ModelServiceConfig>) {
      currentConfig = { ...currentConfig, ...next };
    },
  };
});

vi.mock('../../services/createModelService.js', () => ({
  createModelService: mockCreateModelService,
}));

const { compact } = await import('../CompactionService.js');

describe('Compaction file boundary', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockSideQuery.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tempRoot = await mkdtemp(join(tmpdir(), 'blade-compaction-files-'));
    workspaceRoot = join(tempRoot, 'workspace');
    outsideRoot = join(tempRoot, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('does not read or forward referenced files outside filesystem roots', async () => {
    const outsideFile = join(outsideRoot, 'outside.json');
    await writeFile(outsideFile, '{"token":"must-not-leak"}');

    await compact(
      [{ role: 'user', content: `Inspect ${outsideFile}` }],
      {
        trigger: 'auto',
        modelName: 'gpt-5',
        maxContextTokens: 8_192,
        apiKey: 'test-key',
        filesystemRoots: [workspaceRoot],
        projectDir: workspaceRoot,
      },
    );

    const prompts = mockSideQuery.mock.calls.map((call) =>
      JSON.stringify(call[0]),
    );
    expect(prompts.join('\n')).not.toContain('must-not-leak');
  });

  it('includes bounded non-sensitive files within filesystem roots', async () => {
    const allowedFile = join(workspaceRoot, 'context.ts');
    await writeFile(allowedFile, 'const allowedMarker = true;');

    await compact(
      [{ role: 'user', content: `Inspect ${allowedFile}` }],
      {
        trigger: 'auto',
        modelName: 'gpt-5',
        maxContextTokens: 8_192,
        apiKey: 'test-key',
        filesystemRoots: [workspaceRoot],
        projectDir: workspaceRoot,
      },
    );

    const prompts = mockSideQuery.mock.calls.map((call) =>
      JSON.stringify(call[0]),
    );
    expect(prompts.join('\n')).toContain('const allowedMarker = true;');
  });
});
