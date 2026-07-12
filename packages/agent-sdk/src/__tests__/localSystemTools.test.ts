import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createAskUserQuestionTool, askUserQuestionTool } from '../local/system/askUserQuestion.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local system tools', () => {
  it('includes the AskUserQuestion tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('AskUserQuestion');
  });

  it('creates an AskUserQuestion tool via factory function', () => {
    const tool = createAskUserQuestionTool();
    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('exports a default askUserQuestionTool instance', () => {
    expect(askUserQuestionTool.name).toBe('AskUserQuestion');
    expect(askUserQuestionTool.displayName).toBe('Ask User Question');
  });

  it('AskUserQuestion tool accepts valid build params', () => {
    const tool = createAskUserQuestionTool();
    const invocation = tool.build({
      questions: [
        {
          question: 'What is your preference?',
          header: 'Preference',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'First option' },
            { label: 'Option B', description: 'Second option' },
          ],
        },
      ],
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });
});
