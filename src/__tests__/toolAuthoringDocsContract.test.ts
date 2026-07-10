import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('tool authoring documentation', () => {
  it('documents production custom tool authoring for session-first apps', () => {
    const docPath = 'docs/tool-authoring.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const apiReference = readFileSync('docs/api-reference.md', 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(doc).toContain('@blade-ai/agent-sdk/tools');
    expect(doc).toContain('defineTool');
    expect(doc).toContain('createTool');
    expect(doc).toContain('ToolKind');
    expect(doc).toContain('createToolBehavior');
    expect(doc).toContain('resolveToolBehaviorSafely');
    expect(doc).toContain('ExecutionContext');
    expect(doc).toContain('allowedTools: []');
    expect(doc).toContain('tool_permission_updates');
    expect(doc).toContain('pnpm run verify:examples');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(apiReference).toContain('createToolBehavior');
    expect(apiReference).toContain('resolveToolBehaviorSafely');
    expect(config).toContain("{ text: 'Tool Authoring', link: '/tool-authoring' }");
  });
});
