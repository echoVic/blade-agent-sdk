import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createNotebookEditTool, notebookEditTool } from '../local/notebook/notebookEdit.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local notebook tools', () => {
  it('includes the NotebookEdit tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('NotebookEdit');
  });

  it('creates a NotebookEdit tool via factory function', () => {
    const tool = createNotebookEditTool();
    expect(tool.name).toBe('NotebookEdit');
    expect(tool.kind).toBe(ToolKind.Write);
  });

  it('exports a default notebookEditTool instance', () => {
    expect(notebookEditTool.name).toBe('NotebookEdit');
    expect(notebookEditTool.displayName).toBe('Notebook Edit');
  });

  it('NotebookEdit tool accepts valid build params', () => {
    const tool = createNotebookEditTool();
    const invocation = tool.build({
      notebook_path: '/tmp/test.ipynb',
      new_source: 'print("hello")',
      edit_mode: 'replace',
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });
});
