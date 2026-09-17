import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../SkillRegistry.js';

const BASE_SKILL = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

Instructions for ${name}.
`;

async function createSkill(
  rootDir: string,
  skillDirName: string,
  content: string,
): Promise<string> {
  const skillDir = path.join(rootDir, skillDirName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillFile, content, 'utf-8');
  return skillFile;
}

describe('SkillRegistry project isolation', () => {
  const roots: string[] = [];

  async function projectWith(skillName: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `skills-project-${skillName}-`));
    roots.push(root);
    await createSkill(
      path.join(root, 'skills'),
      skillName,
      BASE_SKILL(skillName, `${skillName} skill`),
    );
    return root;
  }

  afterEach(async () => {
    SkillRegistry.resetInstance();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('discovers each project independently instead of freezing the first configuration', async () => {
    const projectA = await projectWith('alpha');
    const projectB = await projectWith('beta');

    const a = await SkillRegistry.getInstance({ cwd: projectA }).initialize();
    const b = await SkillRegistry.getInstance({ cwd: projectB }).initialize();

    expect(a.skills.map((skill) => skill.name)).toEqual(['alpha']);
    expect(b.skills.map((skill) => skill.name)).toEqual(['beta']);
  });

  it('answers for the project it is asked about, not the one seen first', async () => {
    const projectA = await projectWith('alpha');
    const projectB = await projectWith('beta');

    await SkillRegistry.getInstance({ cwd: projectA }).initialize();
    await SkillRegistry.getInstance({ cwd: projectB }).initialize();

    // Asking A again must still describe A.
    const again = await SkillRegistry.getInstance({ cwd: projectA }).initialize();
    expect(again.skills.map((skill) => skill.name)).toEqual(['alpha']);
  });

  it('re-discovers when the same registry is driven from another directory', async () => {
    const projectA = await projectWith('alpha');
    const projectB = await projectWith('beta');

    // One registry instance whose configuration changes must not keep serving the
    // previous project's Skills.
    const registry = SkillRegistry.getInstance({ cwd: projectA });
    expect((await registry.initialize()).skills.map((skill) => skill.name)).toEqual(['alpha']);
    expect(
      (await registry.initialize({ cwd: projectB })).skills.map((skill) => skill.name),
    ).toEqual(['beta']);
    expect(
      (await registry.initialize({ cwd: projectA })).skills.map((skill) => skill.name),
    ).toEqual(['alpha']);
  });
});

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
    await createSkill(
      bundledDir,
      'bundled-review',
      BASE_SKILL('bundled-review', 'bundled review helper'),
    );
    await createSkill(
      projectSkillsDir,
      'project-review',
      BASE_SKILL('project-review', 'project review helper'),
    );

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

  it('treats different execution policies for the same directory as different registries', async () => {
    const sourceDir = path.join(tmpDir, 'policy-sources');
    await createSkill(sourceDir, 'policy-skill', BASE_SKILL('policy-skill', 'policy bound skill'));

    const allow = SkillRegistry.getInstance({
      additionalSources: [
        {
          kind: 'bundled',
          directory: sourceDir,
          trustLevel: 'trusted',
          shellPolicy: 'allow',
          hookPolicy: 'allow',
        },
      ],
    });
    const deny = SkillRegistry.getInstance({
      additionalSources: [
        {
          kind: 'bundled',
          directory: sourceDir,
          trustLevel: 'workspace',
          shellPolicy: 'deny',
          hookPolicy: 'deny',
        },
      ],
    });

    // Two different execution policies are two configurations: the second caller
    // must not receive the first caller's cached instance and its policy.
    expect(deny).not.toBe(allow);

    const allowed = await allow.initialize();
    const denied = await deny.initialize();
    expect(allowed.skills[0]?.source).toMatchObject({
      trustLevel: 'trusted',
      shellPolicy: 'allow',
    });
    expect(denied.skills[0]?.source).toMatchObject({
      trustLevel: 'workspace',
      shellPolicy: 'deny',
    });

    // The same policy is still the same configuration and stays shared.
    expect(
      SkillRegistry.getInstance({
        additionalSources: [
          {
            kind: 'bundled',
            directory: sourceDir,
            trustLevel: 'trusted',
            shellPolicy: 'allow',
            hookPolicy: 'allow',
          },
        ],
      }),
    ).toBe(allow);
  });

  it('prefers the higher-precedence source when two sources resolve to the same canonical skill path', async () => {
    const canonicalRoot = path.join(tmpDir, 'canonical-skills');
    const shadowRoot = path.join(tmpDir, 'shadow-skills');
    await createSkill(
      canonicalRoot,
      'shared-skill',
      BASE_SKILL('shared-skill', 'canonical version'),
    );
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
    await createSkill(
      projectSkillsDir,
      'src-only',
      `---
name: src-only
description: Only visible for src files
paths:
  - src/**
---

Source focused instructions.
`,
    );
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
