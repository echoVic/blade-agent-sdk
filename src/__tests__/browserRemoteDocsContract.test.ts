import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Browser remote-client documentation', () => {
  it('documents browser-safe imports and remote session streaming', () => {
    const docPath = 'docs/browser-remote-client.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(doc).toContain("@blade-ai/agent-sdk/core");
    expect(doc).toContain("@blade-ai/agent-sdk/browser");
    expect(doc).toContain('StreamMessage');
    expect(doc).toContain('StreamMessageType');
    expect(doc).toContain('application/x-ndjson');
    expect(doc).toContain('HTTP');
    expect(doc).toContain('server-only stub');
    expect(doc).toContain("不要在 'use client' 文件中 import `@blade-ai/agent-sdk` root");
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(config).toContain("{ text: 'Browser Remote Client', link: '/browser-remote-client' }");
  });
});
