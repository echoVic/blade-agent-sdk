import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import {
  createEnterPlanModeTool,
  enterPlanModeTool,
} from '../local/plan/enterPlanMode.js';
import {
  createExitPlanModeTool,
  exitPlanModeTool,
} from '../local/plan/exitPlanMode.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local plan tools', () => {
  it('includes both plan mode tools in the builtin provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('EnterPlanMode');
    expect(names).toContain('ExitPlanMode');
  });

  it('creates an EnterPlanMode tool via factory', () => {
    const tool = createEnterPlanModeTool();
    expect(tool.name).toBe('EnterPlanMode');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('creates an ExitPlanMode tool via factory', () => {
    const tool = createExitPlanModeTool();
    expect(tool.name).toBe('ExitPlanMode');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('exports default instances', () => {
    expect(enterPlanModeTool.name).toBe('EnterPlanMode');
    expect(exitPlanModeTool.name).toBe('ExitPlanMode');
  });

  it('both plan tools accept valid build params', () => {
    const enter = createEnterPlanModeTool();
    const exit = createExitPlanModeTool();

    const enterInv = enter.build({});
    expect(enterInv).toBeDefined();
    expect(typeof enterInv.execute).toBe('function');

    const exitInv = exit.build({ plan: '# Test Plan' });
    expect(exitInv).toBeDefined();
    expect(typeof exitInv.execute).toBe('function');
  });
});
