import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

describe('examples and quickstart documentation', () => {
  it('adds type-checked examples to the production verification chain', () => {
    expect(packageJson.scripts['verify:examples']).toBe('tsc -p examples/tsconfig.json --noEmit');
    expect(packageJson.scripts.verify).toContain('pnpm run verify:examples');
    expect(existsSync('examples/tsconfig.json')).toBe(true);
  });

  it('keeps the session-first server quickstart example available', () => {
    const examplePath = 'examples/session-first-server.ts';

    expect(existsSync(examplePath), `${examplePath} should exist`).toBe(true);
    const source = readFileSync(examplePath, 'utf8');

    expect(source).toContain("import { createSession } from '@blade-ai/agent-sdk';");
    expect(source).toContain('allowedTools: []');
    expect(source).toContain('for await (const event of session.stream())');
    expect(source).toContain('session.close()');
  });

  it('keeps direct package-boundary examples available for ai and agent users', () => {
    const aiExamplePath = 'examples/ai-model-port.ts';
    const agentExamplePath = 'examples/agent-kernel.ts';

    expect(existsSync(aiExamplePath), `${aiExamplePath} should exist`).toBe(true);
    expect(existsSync(agentExamplePath), `${agentExamplePath} should exist`).toBe(true);

    const aiExample = readFileSync(aiExamplePath, 'utf8');
    const agentExample = readFileSync(agentExamplePath, 'utf8');
    const packageGuide = readFileSync('docs/packages.md', 'utf8');

    expect(aiExample).toContain("import { createOpenAICompatibleModelPort } from '@blade-ai/ai';");
    expect(aiExample).toContain('model.generate');
    expect(agentExample).toContain("import { AgentKernel } from '@blade-ai/agent';");
    expect(agentExample).toContain('kernel.runTurn');
    expect(packageGuide).toContain('examples/ai-model-port.ts');
    expect(packageGuide).toContain('examples/agent-kernel.ts');
  });

  it('documents the session-first quickstart and links it from the docs site', () => {
    const docPath = 'docs/session-first-quickstart.md';

    expect(existsSync(docPath), `${docPath} should exist`).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    const config = readFileSync('docs/.vitepress/config.ts', 'utf8');

    expect(doc).toContain("import { createSession } from '@blade-ai/agent-sdk';");
    expect(doc).toContain('examples/session-first-server.ts');
    expect(doc).toContain('pnpm run verify:examples');
    expect(doc).toContain('allowedTools: []');
    expect(doc).not.toMatch(/\bTBD\b|\bTODO\b|待补充/);
    expect(config).toContain("{ text: 'Session-first 快速开始', link: '/session-first-quickstart' }");
  });
});
