import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { skillTool } from '../local/system/skill.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local skill tool', () => {
  it('includes the Skill tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('Skill');
  });

  it('exports a default skillTool instance', () => {
    expect(skillTool.name).toBe('Skill');
    expect(skillTool.displayName).toBe('Skill');
    expect(skillTool.kind).toBe(ToolKind.Execute);
  });

  it('Skill tool accepts valid build params', () => {
    const invocation = skillTool.build({
      skill: 'test-skill',
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });

  it('Skill tool returns error when no registry is available', async () => {
    const invocation = skillTool.build({ skill: 'test-skill' });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('not available');
  });
});
