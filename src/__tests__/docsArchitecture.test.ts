import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(path: string): string {
  expect(existsSync(path), `${path} should exist`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('production architecture documentation', () => {
  it('documents the ai/agent/agent-sdk package boundaries and dependency direction', () => {
    const doc = readDoc('docs/architecture.md');

    expect(doc).toContain('@blade-ai/ai');
    expect(doc).toContain('@blade-ai/agent');
    expect(doc).toContain('@blade-ai/agent-sdk');
    expect(doc).toContain('@blade-ai/agent-sdk -> @blade-ai/agent -> @blade-ai/ai');
    expect(doc).toContain('session-first');
    expect(doc).toContain('runtime-independent');
    expect(doc).toContain('Node-only');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
  });

  it('documents public package usage, runtime boundaries, and recommended imports', () => {
    const doc = readDoc('docs/packages.md');

    expect(doc).toContain("import { createSession } from '@blade-ai/agent-sdk';");
    expect(doc).toContain('@blade-ai/agent-sdk/core');
    expect(doc).toContain('@blade-ai/agent-sdk/local');
    expect(doc).toContain('@blade-ai/ai/providers/openai-compatible');
    expect(doc).toContain('@blade-ai/agent');
    expect(doc).toContain('Browser-safe');
    expect(doc).toContain('Server / CLI');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
  });

  it('exposes the architecture and package guides in VitePress navigation', () => {
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(config).toContain("{ text: '架构说明', link: '/architecture' }");
    expect(config).toContain("{ text: '包与入口', link: '/packages' }");
  });

  it('keeps roadmap wording aligned with retired root streaming adapters', () => {
    const roadmap = readDoc('docs/roadmap/production-agent-sdk-monorepo.md');

    expect(existsSync('src/agent/StreamingToolExecutor.ts')).toBe(false);
    expect(existsSync('src/agent/loop/streamChatResponse.ts')).toBe(false);
    expect(roadmap).not.toContain(
      'the root `StreamingToolExecutor` path is now a compatibility wrapper',
    );
    expect(roadmap).not.toContain(
      'the root `streamChatResponse()` path is now a compatibility wrapper',
    );
  });
});
