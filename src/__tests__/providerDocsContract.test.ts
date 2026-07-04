import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('provider documentation', () => {
  it('documents session-first and low-level provider package usage', () => {
    const docPath = 'docs/providers.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(doc).toContain("import { createSession } from '@blade-ai/agent-sdk';");
    expect(doc).toContain('@blade-ai/ai/providers/openai-compatible');
    expect(doc).toContain('@blade-ai/ai/providers/vercel');
    expect(doc).toContain('ModelPort');
    expect(doc).toContain('glm-5.2');
    expect(doc).toContain('pnpm run test:live:glm');
    expect(doc).toContain('usage');
    expect(doc).toContain('stream');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(config).toContain("{ text: 'Provider 与模型', link: '/providers' }");
  });
});
