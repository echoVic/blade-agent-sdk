import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionMode } from '../../types/common.js';
import { buildSystemPrompt } from '../builder.js';
import { PLAN_MODE_SYSTEM_PROMPT } from '../default.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blade-prompt-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('buildSystemPrompt', () => {
  it('places environment context before the caller-provided prompt content', async () => {
    const promptProject = await createProjectDir();

    const result = await buildSystemPrompt({
      projectPath: promptProject,
      basePrompt: 'BASE PROMPT',
      append: 'APPEND PROMPT',
    });

    expect(result.sources.map((source) => source.name)).toEqual([
      'environment',
      'base_prompt',
      'append',
    ]);
    expect(result.prompt).toContain('# Environment Context');
    expect(result.prompt).toContain('BASE PROMPT\n\n---\n\nAPPEND PROMPT');
    expect(result.prompt.indexOf('# Environment Context')).toBeLessThan(
      result.prompt.indexOf('BASE PROMPT')
    );
  });

  it('uses the caller-provided base prompt and append content', async () => {
    const promptProject = await createProjectDir();

    const result = await buildSystemPrompt({
      projectPath: promptProject,
      basePrompt: 'BASE PROMPT',
      append: 'APPEND PROMPT',
      includeEnvironment: false,
    });

    expect(result.prompt).toBe('BASE PROMPT\n\n---\n\nAPPEND PROMPT');
    expect(result.sources.map((source) => source.name)).toEqual(['base_prompt', 'append']);
  });

  it('does not implicitly load BLADE.md outside plan mode', async () => {
    const promptProject = await createProjectDir();
    await writeFile(join(promptProject, 'BLADE.md'), 'PROJECT PROMPT', 'utf8');

    const result = await buildSystemPrompt({
      projectPath: promptProject,
      includeEnvironment: false,
    });

    expect(result.prompt).toBe('');
    expect(result.sources).toEqual([]);
  });

  it('uses the built-in or overridden plan mode prompt', async () => {
    const defaultPlanResult = await buildSystemPrompt({
      mode: PermissionMode.PLAN,
      includeEnvironment: false,
    });
    expect(defaultPlanResult.prompt).toBe(PLAN_MODE_SYSTEM_PROMPT);

    const customPlanResult = await buildSystemPrompt({
      mode: PermissionMode.PLAN,
      planModePrompt: 'CUSTOM PLAN PROMPT',
      append: 'PLAN APPENDIX',
      includeEnvironment: false,
    });

    expect(customPlanResult.prompt).toBe('CUSTOM PLAN PROMPT\n\n---\n\nPLAN APPENDIX');
    expect(customPlanResult.sources.map((source) => source.name)).toEqual([
      'plan_mode_prompt',
      'append',
    ]);
  });

  it('prefers the plan mode prompt over a regular base prompt', async () => {
    const result = await buildSystemPrompt({
      mode: PermissionMode.PLAN,
      basePrompt: 'BASE PROMPT',
      planModePrompt: 'CUSTOM PLAN PROMPT',
      includeEnvironment: false,
    });

    expect(result.prompt).toBe('CUSTOM PLAN PROMPT');
    expect(result.prompt.includes('BASE PROMPT')).toBe(false);
    expect(result.sources.map((source) => source.name)).toEqual(['plan_mode_prompt']);
  });
});
