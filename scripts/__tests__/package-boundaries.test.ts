import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function createBoundaryFixture(options: {
  aiDependencies?: Record<string, string>;
  agentDependencies?: Record<string, string>;
  sdkDependencies?: Record<string, string>;
} = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'blade-boundaries-'));
  for (const packageName of ['ai', 'agent', 'agent-sdk']) {
    mkdirSync(join(cwd, 'packages', packageName, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'packages', packageName, 'src', 'index.ts'), 'export {};\n');
  }

  writeJson(join(cwd, 'packages', 'ai', 'package.json'), {
    name: '@blade-ai/ai',
    dependencies: options.aiDependencies ?? {},
  });
  writeJson(join(cwd, 'packages', 'agent', 'package.json'), {
    name: '@blade-ai/agent',
    dependencies: options.agentDependencies ?? {},
  });
  writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
    name: '@blade-ai/agent-sdk',
    dependencies: options.sdkDependencies ?? {},
  });

  return cwd;
}

describe('package boundary verifier', () => {
  it('rejects runtime-local dependencies declared by the agent kernel manifest', () => {
    const cwd = createBoundaryFixture({
      agentDependencies: {
        '@blade-ai/ai': 'workspace:*',
        '@modelcontextprotocol/sdk': '^1.29.0',
      },
    });
    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent/package.json');
    expect(result.stderr).toContain('@modelcontextprotocol/sdk');
    expect(result.stderr).toContain('Agent kernel');
  });

  it('rejects session-sdk dependencies declared by the agent kernel manifest', () => {
    const cwd = createBoundaryFixture({
      agentDependencies: {
        '@blade-ai/agent-sdk': 'workspace:*',
      },
    });
    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent/package.json');
    expect(result.stderr).toContain('@blade-ai/agent-sdk');
    expect(result.stderr).toContain('Agent kernel');
  });

  it('rejects upper-layer dependencies declared by the ai manifest', () => {
    const cwd = createBoundaryFixture({
      aiDependencies: {
        '@blade-ai/agent': 'workspace:*',
        '@blade-ai/agent-sdk': 'workspace:*',
      },
    });
    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/ai/package.json');
    expect(result.stderr).toContain('@blade-ai/agent');
    expect(result.stderr).toContain('@blade-ai/agent-sdk');
    expect(result.stderr).toContain('AI package');
  });

  it('rejects provider runtime dependencies declared by the session-sdk manifest', () => {
    const cwd = createBoundaryFixture({
      sdkDependencies: {
        ai: '^6.0.168',
      },
    });
    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('"ai"');
    expect(result.stderr).toContain('Provider runtime');
  });

  it('rejects session-sdk source imports that leave the package source tree', () => {
    const cwd = createBoundaryFixture();
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'index.ts'),
      "export * from '../../../src/index.js';\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/index.ts');
    expect(result.stderr).toContain("relative import \"../../../src/index.js\"");
    expect(result.stderr).toContain('leaves packages/agent-sdk/src');
  });
});
