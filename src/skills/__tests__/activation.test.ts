import { describe, expect, it } from 'vitest';
import {
  collectSkillActivationPaths,
  isSkillAvailableInContext,
} from '../activation.js';
import type { SkillMetadata } from '../types.js';

function createSkill(patterns: string[]): SkillMetadata {
  return {
    name: 'test-skill',
    description: 'test',
    path: '/tmp/skills/test-skill/SKILL.md',
    basePath: '/tmp/skills/test-skill',
    source: {
      kind: 'project',
      trustLevel: 'workspace',
      sourceId: 'project',
      precedence: 100,
      shellPolicy: 'inherit',
      hookPolicy: 'inherit',
    },
    conditions: { paths: patterns },
  };
}

describe('skills activation', () => {
  it('collects language-agnostic file candidates from args', () => {
    expect(
      collectSkillActivationPaths({
        args: 'main.py config.toml notes.md',
      }),
    ).toEqual(['main.py', 'config.toml', 'notes.md']);
  });

  it('matches conditions against generic extension-based file names', () => {
    const skill = createSkill(['*.py']);

    expect(isSkillAvailableInContext(skill, { args: 'main.py' })).toBe(true);
    expect(isSkillAvailableInContext(skill, { args: 'main.go' })).toBe(false);
  });

  it('still matches nested paths from args', () => {
    const skill = createSkill(['configs/**/*.toml']);

    expect(
      isSkillAvailableInContext(skill, {
        args: 'configs/dev/app.toml',
      }),
    ).toBe(true);
  });
});
