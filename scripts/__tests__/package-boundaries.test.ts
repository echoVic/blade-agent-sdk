import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeTsupConfig(path: string, entries: Record<string, string>): void {
  const entryLines = Object.entries(entries)
    .map(([name, entry]) => `    ${JSON.stringify(name)}: ${JSON.stringify(entry)},`)
    .join('\n');
  writeFileSync(
    path,
    `import { defineConfig } from 'tsup';\n\nexport default defineConfig({\n  entry: {\n${entryLines}\n  },\n});\n`,
  );
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
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './package.json': {
        default: './package.json',
      },
    },
    dependencies: options.aiDependencies ?? {},
  });
  writeJson(join(cwd, 'packages', 'agent', 'package.json'), {
    name: '@blade-ai/agent',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './package.json': {
        default: './package.json',
      },
    },
    dependencies: options.agentDependencies ?? {},
  });
  writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
    name: '@blade-ai/agent-sdk',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './package.json': {
        default: './package.json',
      },
    },
    dependencies: options.sdkDependencies ?? {},
  });
  writeTsupConfig(join(cwd, 'packages', 'ai', 'tsup.config.ts'), {
    index: 'src/index.ts',
  });
  writeTsupConfig(join(cwd, 'packages', 'agent', 'tsup.config.ts'), {
    index: 'src/index.ts',
  });
  writeTsupConfig(join(cwd, 'packages', 'agent-sdk', 'tsup.config.ts'), {
    index: 'src/index.ts',
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

  it('rejects session-sdk source imports from its own public facade', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'session'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'session', 'feature.ts'),
      "import { createSession } from '@blade-ai/agent-sdk/session';\nexport { createSession };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/session/feature.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session');
    expect(result.stderr).toContain('Session SDK source must not import its own public facade');
  });

  it('rejects ai source imports from its own public facade', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'ai', 'src', 'model'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'ai', 'src', 'model', 'feature.ts'),
      "import type { ModelPort } from '@blade-ai/ai/model';\nexport type FeaturePort = ModelPort;\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/ai/src/model/feature.ts');
    expect(result.stderr).toContain('@blade-ai/ai/model');
    expect(result.stderr).toContain('AI package source must not import its own public facade');
  });

  it('rejects agent source imports from its own public facade', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent', 'src', 'kernel'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent', 'src', 'kernel', 'feature.ts'),
      "import type { AgentKernel } from '@blade-ai/agent/kernel';\nexport type FeatureKernel = AgentKernel;\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent/src/kernel/feature.ts');
    expect(result.stderr).toContain('@blade-ai/agent/kernel');
    expect(result.stderr).toContain('Agent kernel source must not import its own public facade');
  });

  it('rejects package source relative imports without runtime file extensions', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent', 'src', 'kernel'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'agent', 'src', 'kernel', 'index.ts'), 'export {};\n');
    writeFileSync(
      join(cwd, 'packages', 'agent', 'src', 'index.ts'),
      "export * from './kernel';\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent/src/index.ts');
    expect(result.stderr).toContain('relative import "./kernel"');
    expect(result.stderr).toContain('must include an explicit runtime file extension');
  });

  it('rejects package build entries that leave the package source tree', () => {
    const cwd = createBoundaryFixture();
    writeTsupConfig(join(cwd, 'packages', 'agent-sdk', 'tsup.config.ts'), {
      index: '../../src/index.ts',
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/tsup.config.ts');
    expect(result.stderr).toContain('build entry "index"');
    expect(result.stderr).toContain('leaves packages/agent-sdk/src');
  });

  it('rejects publish exports that expose source files instead of dist artifacts', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './src/index.ts',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './src/index.ts',
        },
        './package.json': {
          default: './package.json',
        },
      },
      dependencies: {},
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('main target "./src/index.ts"');
    expect(result.stderr).toContain('export "." import target "./src/index.ts"');
    expect(result.stderr).toContain('must point at ./dist artifacts');
  });

  it('rejects publish exports without paired types and import conditions', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './tools': {
          import: './dist/tools/index.js',
        },
        './browser': './dist/browser/index.js',
        './package.json': {
          default: './package.json',
        },
      },
      dependencies: {},
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('export "./tools" must declare a types condition');
    expect(result.stderr).toContain('export "./browser" must be a condition object');
  });

  it('rejects CLI product entrypoints in the session SDK manifest', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      bin: {
        blade: './dist/cli.js',
      },
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './cli': {
          types: './dist/cli/index.d.ts',
          import: './dist/cli/index.js',
        },
        './package.json': {
          default: './package.json',
        },
      },
      dependencies: {},
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('bin field');
    expect(result.stderr).toContain('export "./cli"');
    expect(result.stderr).toContain('CLI product capabilities belong in a separate package');
  });

  it('rejects CLI product capabilities in ai and agent library manifests', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'ai', 'package.json'), {
      name: '@blade-ai/ai',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      bin: {
        'blade-ai': './dist/cli.js',
      },
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './cli': {
          types: './dist/cli/index.d.ts',
          import: './dist/cli/index.js',
        },
        './package.json': {
          default: './package.json',
        },
      },
      keywords: ['ai', 'cli'],
      dependencies: {},
    });
    writeJson(join(cwd, 'packages', 'agent', 'package.json'), {
      name: '@blade-ai/agent',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      bin: {
        'blade-agent': './dist/cli.js',
      },
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './cli': {
          types: './dist/cli/index.d.ts',
          import: './dist/cli/index.js',
        },
        './package.json': {
          default: './package.json',
        },
      },
      keywords: ['agent', 'cli'],
      dependencies: {},
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/ai/package.json');
    expect(result.stderr).toContain('packages/agent/package.json');
    expect(result.stderr).toContain('bin field');
    expect(result.stderr).toContain('export "./cli"');
    expect(result.stderr).toContain('keyword "cli"');
    expect(result.stderr).toContain('CLI product capabilities belong in a separate package');
  });

  it('rejects CLI product keywords in the session SDK manifest', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './package.json': {
          default: './package.json',
        },
      },
      keywords: ['agent', 'sdk', 'cli'],
      dependencies: {},
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('keyword "cli"');
    expect(result.stderr).toContain('CLI product capabilities belong in a separate package');
  });
});
