import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SkillRegistry } from '../../../../skills/SkillRegistry.js';
import { SessionId } from '../../../../types/identifiers.js';
import type { ExecutionContext } from '../../../types/execution.js';
import { collectToolExecution, type ToolYield } from '../../../types/result.js';
import { skillTool } from '../skill.js';

async function createProjectSkill(
  projectRoot: string,
  name: string,
  content: string,
): Promise<void> {
  const skillDir = path.join(projectRoot, 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
}

async function executeSkill(
  params: Parameters<typeof skillTool.build>[0],
  context: Partial<ExecutionContext>,
) {
  const invocation = skillTool.build(params);
  const events: ToolYield[] = [];
  const result = await collectToolExecution(
    invocation.execute(new AbortController().signal, context),
    (event) => {
      events.push(event);
    },
  );
  return { result, events };
}

describe('Skill tool', () => {
  let projectRoot: string;

  beforeEach(async () => {
    SkillRegistry.resetInstance();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tool-'));
  });

  afterEach(() => {
    SkillRegistry.resetInstance();
  });

  it('rejects explicit activation when path conditions are not satisfied', async () => {
    await createProjectSkill(
      projectRoot,
      'src-only',
      `---
name: src-only
description: Only for source files
paths:
  - src/**
---

Focus on source files.
`,
    );

    const registry = SkillRegistry.getInstance({
      cwd: projectRoot,
      projectSkillsDir: 'skills',
    });
    await registry.initialize();

    const context = {
      contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
        capabilities: {
          filesystem: {
            roots: [projectRoot],
            cwd: projectRoot,
          },
        },
      }),
      skillActivationPaths: ['docs/readme.md'],
    } satisfies Partial<ExecutionContext>;

    const { result } = await executeSkill({ skill: 'src-only' }, context);

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('conditions are not satisfied');
  });

  it('allows explicit activation when args satisfy path conditions', async () => {
    await createProjectSkill(
      projectRoot,
      'src-only',
      `---
name: src-only
description: Only for source files
paths:
  - src/**
---

Focus on source files.
`,
    );

    const registry = SkillRegistry.getInstance({
      cwd: projectRoot,
      projectSkillsDir: 'skills',
    });
    await registry.initialize();

    const context = {
      contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
        capabilities: {
          filesystem: {
            roots: [projectRoot],
            cwd: projectRoot,
          },
        },
      }),
    } satisfies Partial<ExecutionContext>;

    const { result } = await executeSkill({ skill: 'src-only', args: 'src/index.ts' }, context);

    expect(result.status).toBe('success');
    expect(String(result.model)).toContain('Focus on source files.');
  });

  it('returns skill activation as a runtimePatch effect', async () => {
    await createProjectSkill(
      projectRoot,
      'reviewer',
      `---
name: reviewer
description: Review code carefully
allowed-tools:
  - Read
model: gpt-5.4
scope: turn
---

Review code carefully.
`,
    );

    const registry = SkillRegistry.getInstance({
      cwd: projectRoot,
      projectSkillsDir: 'skills',
    });
    await registry.initialize();

    const context = {
      contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
        capabilities: {
          filesystem: {
            roots: [projectRoot],
            cwd: projectRoot,
          },
        },
      }),
    } satisfies Partial<ExecutionContext>;

    const { result, events } = await executeSkill({ skill: 'reviewer' }, context);

    expect(result.status).toBe('success');
    expect(events).toEqual([
      {
        kind: 'effect',
        effect: {
          type: 'runtimePatch',
          patch: {
            scope: 'turn',
            source: 'skill',
            skill: {
              id: 'reviewer',
              name: 'reviewer',
              basePath: path.join(projectRoot, 'skills', 'reviewer'),
            },
            toolPolicy: {
              allow: ['Read'],
              deny: undefined,
            },
            modelOverride: {
              modelId: 'gpt-5.4',
              effort: undefined,
            },
            systemPromptAppend: undefined,
            environment: undefined,
            hooks: undefined,
          },
        },
      },
    ]);
  });
});
