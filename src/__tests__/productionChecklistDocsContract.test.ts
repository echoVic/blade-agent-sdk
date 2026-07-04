import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Production checklist documentation', () => {
  it('documents the production gates for release-ready agent SDK changes', () => {
    const docPath = 'docs/production-checklist.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    for (const requiredText of [
      'pnpm run verify',
      'pnpm run verify:packages',
      'pnpm run verify:entrypoints',
      'pnpm run test:live:glm',
      'pnpm run test:live:session-glm',
      'pnpm run release:dry',
      'semantic-release',
      'trusted publishing',
      'session-first',
      'browser-safe',
      '@blade-ai/agent',
      '@blade-ai/ai',
      '@blade-ai/agent-sdk',
    ]) {
      expect(doc).toContain(requiredText);
    }

    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(config).toContain("{ text: 'Production Checklist', link: '/production-checklist' }");
  });
});
