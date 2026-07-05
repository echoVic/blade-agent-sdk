import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('session API documentation contract', () => {
  it('documents the kernel-only stream options contract', () => {
    const docPath = 'docs/session.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');

    expect(doc).toContain('includeThinking?: boolean');
    expect(doc).toContain('默认通过 `@blade-ai/agent` 的运行时无关 `AgentKernel` 执行');
    expect(doc).not.toContain("runtime?: 'kernel' | 'legacy'");
    expect(doc).not.toContain("runtime: 'legacy'");
    expect(doc).not.toContain('experimentalKernel');
  });
});
