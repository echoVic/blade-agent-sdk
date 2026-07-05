import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const subagentsModulePath = '../../packages/agent-sdk/src/session/runtimeSubagents.js';
const subagentsSourcePath = 'packages/agent-sdk/src/session/runtimeSubagents.ts';

describe('agent-sdk package-local runtime subagent helpers', () => {
  it('maps session agent definitions to package-local subagent configs without runtime state', async () => {
    expect(existsSync(subagentsSourcePath)).toBe(true);

    const { packageLocalSubagentConfigFromDefinition } = await import(subagentsModulePath);

    expect(
      packageLocalSubagentConfigFromDefinition('reviewer', {
        description: 'Review code',
        systemPrompt: 'Be direct',
        allowedTools: ['read', 'edit'],
      }),
    ).toEqual({
      name: 'reviewer',
      description: 'Review code',
      systemPrompt: 'Be direct',
      tools: ['read', 'edit'],
      model: 'inherit',
      source: 'session',
    });

    expect(
      packageLocalSubagentConfigFromDefinition('reviewer', {
        name: 'strict-reviewer',
        description: 'Review code strictly',
        systemPrompt: 'Be stricter',
        model: 'glm-5.2',
      }),
    ).toMatchObject({
      name: 'strict-reviewer',
      model: 'glm-5.2',
      source: 'session',
    });
  });
});
