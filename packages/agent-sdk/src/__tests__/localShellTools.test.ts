import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { bashTool, killShellTool } from '../local/shell/index.js';
import { BackgroundShellManager } from '../local/shell/BackgroundShellManager.js';
import { OutputTruncator } from '../local/shell/OutputTruncator.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local shell tools', () => {
  it('includes Bash and KillShell in default builtin tools', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('Bash');
    expect(names).toContain('KillShell');
  });

  it('bashTool has correct metadata', () => {
    expect(bashTool.name).toBe('Bash');
    expect(bashTool.kind).toBe(ToolKind.Execute);
  });

  it('killShellTool has correct metadata', () => {
    expect(killShellTool.name).toBe('KillShell');
    expect(killShellTool.kind).toBe(ToolKind.Execute);
  });

  it('BackgroundShellManager is a singleton', () => {
    const a = BackgroundShellManager.getInstance();
    const b = BackgroundShellManager.getInstance();
    expect(a).toBe(b);
  });

  it('OutputTruncator truncates long output', () => {
    const longLine = 'x'.repeat(200);
    const output = Array.from({ length: 200 }, () => longLine).join('\n');
    const result = OutputTruncator.truncate(output, 'ls');
    expect(result.truncated).toBe(true);
    expect(result.originalLines).toBe(200);
  });

  it('OutputTruncator does not truncate short output', () => {
    const result = OutputTruncator.truncate('hello world', 'echo');
    expect(result.truncated).toBe(false);
  });
});
