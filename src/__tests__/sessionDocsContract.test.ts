import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('session API documentation contract', () => {
  it('documents the kernel stream default and legacy runtime escape hatch', () => {
    const docPath = 'docs/session.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');

    expect(doc).toContain("runtime?: 'kernel' | 'legacy'");
    expect(doc).toContain('默认 kernel');
    expect(doc).toContain("session.stream({ runtime: 'legacy' })");
    expect(doc).toContain('experimentalKernel');
    expect(doc).not.toMatch(/experimentalKernel[\s\S]{0,120}默认值为 `false`/);
    expect(doc).not.toMatch(/experimentalKernel[\s\S]{0,120}默认 false/);
  });
});
