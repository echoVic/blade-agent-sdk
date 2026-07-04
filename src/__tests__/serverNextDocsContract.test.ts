import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Server and Next.js documentation', () => {
  it('documents the server-only session-first boundary for Next.js apps', () => {
    const docPath = 'docs/server-nextjs.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(doc).toContain("import { createSession } from '@blade-ai/agent-sdk';");
    expect(doc).toContain("export const runtime = 'nodejs';");
    expect(doc).toContain('allowedTools: []');
    expect(doc).toContain("@blade-ai/agent-sdk/core");
    expect(doc).toContain("@blade-ai/agent-sdk/tools");
    expect(doc).toContain('HTTP');
    expect(doc).toContain('server-only');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(config).toContain("{ text: 'Server / Next.js', link: '/server-nextjs' }");
  });
});
