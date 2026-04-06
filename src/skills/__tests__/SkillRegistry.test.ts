import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../SkillRegistry.js';

const BASE_SKILL = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

Instructions for ${name}.
`;

async function createSkill(rootDir: string, skillDirName: string, content: string): Promise<string> {
  const skillDir = path.join(rootDir, skillDirName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillFile, content, 'utf-8');
  return skillFile;
}

describe('SkillRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    SkillRegistry.resetInstance();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-registry-'));
  });

  afterEach(() => {
    SkillRegistry.resetInstance();
  });

  it('prefers higher-precedence sources while deduplicating canonical paths', async () => {
    const userDir = path.join(tmpDir, 'user');
    const projectDir = path.join(tmpDir, 'project', 'skills');
    await createSkill(userDir, 'shared-skill', BASE_SKILL('shared-skill', 'user version'));
    await createSkill(projectDir, 'shared-skill', BASE_SKILL('shared-skill', 'project version'));

    const registry = new SkillRegistry({
      cwd: path.join(tmpDir, 'project'),
      userSkillsDir: userDir,
      projectSkillsDir: 'skills',
    });

    const result = await registry.initialize();

    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe('project version');
    expect(result.skills[0].source.kind).toBe('project');
    expect(result.skills[0].source.precedence).toBeGreaterThan(0);
  });

  it('loads additional bundled sources alongside project skills', async () => {
    const bundledDir = path.join(tmpDir, 'bundled');
    const projectRoot = path.join(tmpDir, 'workspace');
    const projectSkillsDir = path.join(projectRoot, 'skills');
    await createSkill(bundledDir, 'bundled-review', BASE_SKILL('bundled-review', 'bundled review helper'));
    await createSkill(projectSkillsDir, 'project-review', BASE_SKILL('project-review', 'project review helper'));

    const registry = new SkillRegistry({
      cwd: projectRoot,
      projectSkillsDir: 'skills',
      additionalSources: [
        {
          kind: 'bundled',
          directory: bundledDir,
          precedence: 10,
          trustLevel: 'trusted',
        },
      ],
    });

    await registry.initialize();

    expect(registry.get('bundled-review')?.source.kind).toBe('bundled');
    expect(registry.get('project-review')?.source.kind).toBe('project');
  });

  it('prefers the higher-precedence source when two sources resolve to the same canonical skill path', async () => {
    const canonicalRoot = path.join(tmpDir, 'canonical-skills');
    const shadowRoot = path.join(tmpDir, 'shadow-skills');
    await createSkill(canonicalRoot, 'shared-skill', BASE_SKILL('shared-skill', 'canonical version'));
    await fs.symlink(canonicalRoot, shadowRoot);

    const registry = new SkillRegistry({
      additionalSources: [
        {
          kind: 'bundled',
          directory: shadowRoot,
          precedence: 10,
          trustLevel: 'trusted',
        },
        {
          kind: 'project',
          directory: canonicalRoot,
          precedence: 20,
          trustLevel: 'workspace',
        },
      ],
    });

    const result = await registry.initialize();

    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].source.kind).toBe('project');
    expect(result.skills[0].source.precedence).toBe(20);
    expect(registry.get('shared-skill')?.source.kind).toBe('project');
  });

  it('filters skills with path conditions from model-visible listings when the activation context does not match', async () => {
    const projectRoot = path.join(tmpDir, 'workspace');
    const projectSkillsDir = path.join(projectRoot, 'skills');
    await createSkill(projectSkillsDir, 'src-only', `---
name: src-only
description: Only visible for src files
paths:
  - src/**
---

Source focused instructions.
`);
    await createSkill(projectSkillsDir, 'always-on', BASE_SKILL('always-on', 'Always visible'));

    const registry = new SkillRegistry({
      cwd: projectRoot,
      projectSkillsDir: 'skills',
    });

    await registry.initialize();

    expect(
      registry.generateAvailableSkillsList({
        cwd: projectRoot,
        referencedPaths: ['src/index.ts'],
      }),
    ).toContain('src-only');

    expect(
      registry.generateAvailableSkillsList({
        cwd: projectRoot,
        referencedPaths: ['docs/readme.md'],
      }),
    ).not.toContain('src-only');

    expect(registry.generateAvailableSkillsList()).toContain('always-on');
  });
});
