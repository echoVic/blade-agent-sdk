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
    mkdirSync(join(cwd, 'packages', packageName, 'dist'), { recursive: true });
    writeFileSync(join(cwd, 'packages', packageName, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', packageName, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', packageName, 'dist', 'index.d.ts'), 'export {};\n');
  }
  mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser'), { recursive: true });
  mkdirSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'browser'), { recursive: true });
  writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser', 'index.ts'), 'export {};\n');
  writeFileSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'browser', 'index.js'), 'export {};\n');
  writeFileSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'browser', 'index.d.ts'), 'export {};\n');

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
        browser: './dist/browser/index.js',
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
    'browser/index': 'src/browser/index.ts',
  });

  return cwd;
}

describe('package boundary verifier', () => {
  it('rejects unpinned dependency ranges in source manifests', () => {
    const cwd = createBoundaryFixture({
      sdkDependencies: {
        zod: '^3.25.76',
      },
    });
    writeJson(join(cwd, 'package.json'), {
      name: 'blade-agent-sdk-monorepo',
      private: true,
      devDependencies: {
        typescript: '~6.0.3',
      },
    });

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).toContain('devDependencies "typescript"');
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('dependencies "zod"');
    expect(result.stderr).toContain('must use an exact dependency version');
  });

  it('rejects non-workspace internal dependency versions in source manifests', () => {
    const cwd = createBoundaryFixture({
      agentDependencies: {
        '@blade-ai/ai': '0.0.0',
      },
      sdkDependencies: {
        '@blade-ai/agent': '0.0.0',
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
    expect(result.stderr).toContain('dependencies "@blade-ai/ai"');
    expect(result.stderr).toContain('packages/agent-sdk/package.json');
    expect(result.stderr).toContain('dependencies "@blade-ai/agent"');
    expect(result.stderr).toContain('internal @blade-ai dependencies must use workspace:*');
  });

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

  it('rejects node-only imports from agent-sdk browser-safe source', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'core'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'core', 'index.ts'),
      "import { readFile } from 'node:fs/promises';\nexport { readFile };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/core/index.ts');
    expect(result.stderr).toContain('node:fs/promises');
    expect(result.stderr).toContain('Browser-safe SDK source');
  });

  it('rejects node-only imports from agent-sdk errors source', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'errors'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'errors', 'index.ts'),
      "import { readFile } from 'node:fs/promises';\nexport { readFile };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/errors/index.ts');
    expect(result.stderr).toContain('node:fs/promises');
    expect(result.stderr).toContain('Browser-safe SDK source');
  });

  it('rejects node-only imports from agent-sdk tools source', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'tools'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'tools', 'index.ts'),
      "import { readFile } from 'node:fs/promises';\nexport { readFile };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/tools/index.ts');
    expect(result.stderr).toContain('node:fs/promises');
    expect(result.stderr).toContain('Browser-safe SDK source');
  });

  it('rejects node-only imports from the agent-sdk browser-safe static import closure', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'core'), { recursive: true });
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'types'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'core', 'index.ts'),
      "export { readConfig } from '../types/config.js';\n",
    );
    writeFileSync(
      join(cwd, 'packages', 'agent-sdk', 'src', 'types', 'config.ts'),
      "import { readFile } from 'node:fs/promises';\nexport const readConfig = readFile;\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/agent-sdk/src/types/config.ts');
    expect(result.stderr).toContain('node:fs/promises');
    expect(result.stderr).toContain('Browser-safe SDK source static closure');
  });

  it('rejects legacy root source imports that use workspace path aliases', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'legacy.ts'),
      "import type { SessionId } from '@/types/branded.js';\nexport type LegacySessionId = SessionId;\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts');
    expect(result.stderr).toContain('@/types/branded.js');
    expect(result.stderr).toContain('Legacy root source');
  });

  it('rejects legacy root source imports that deep-link into package source', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'legacy.ts'),
      "export * from '../packages/agent/src/index.js';\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/legacy.ts');
    expect(result.stderr).toContain('../packages/agent/src/index.js');
    expect(result.stderr).toContain('must import package public subpaths');
  });

  it('rejects new legacy root consumers of the session internal migration subpath', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'feature.ts'),
      "import { runPackageLocalTurn } from '@blade-ai/agent-sdk/session/internal';\nexport { runPackageLocalTurn };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/feature.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session/internal');
    expect(result.stderr).toContain('migration-only session internal subpath');
  });

  it('rejects the retired root executeToolCalls adapter as a session internal consumer', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent', 'loop'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'loop', 'executeToolCalls.ts'),
      "import { executePackageLocalToolCalls } from '@blade-ai/agent-sdk/session/internal';\nexport { executePackageLocalToolCalls };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/loop/executeToolCalls.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session/internal');
    expect(result.stderr).toContain('migration-only session internal subpath');
  });

  it('rejects the retired root streamChatResponse adapter as a session internal consumer', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent', 'loop'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'loop', 'streamChatResponse.ts'),
      "import { streamPackageLocalChatResponse } from '@blade-ai/agent-sdk/session/internal';\nexport { streamPackageLocalChatResponse };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/loop/streamChatResponse.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session/internal');
    expect(result.stderr).toContain('migration-only session internal subpath');
  });

  it('rejects the retired root StreamingToolExecutor adapter as a session internal consumer', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'StreamingToolExecutor.ts'),
      "import { PackageLocalStreamingToolExecutor } from '@blade-ai/agent-sdk/session/internal';\nexport { PackageLocalStreamingToolExecutor };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/StreamingToolExecutor.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session/internal');
    expect(result.stderr).toContain('migration-only session internal subpath');
  });

  it('rejects the retired root runToolCall adapter as a session internal consumer', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent', 'loop'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'loop', 'runToolCall.ts'),
      "import { runPackageLocalToolCall } from '@blade-ai/agent-sdk/session/internal';\nexport { runPackageLocalToolCall };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/loop/runToolCall.ts');
    expect(result.stderr).toContain('@blade-ai/agent-sdk/session/internal');
    expect(result.stderr).toContain('migration-only session internal subpath');
  });

  it('rejects the root agent loop adapter importing the wrong bridge', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent', 'loop'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'agent', 'loop', 'rootAgentLoopAdapter.ts'),
      "import { runPackageLocalTurn } from '@blade-ai/agent-sdk/session/internal';\nexport { runPackageLocalTurn };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/loop/rootAgentLoopAdapter.ts');
    expect(result.stderr).toContain('runPackageLocalTurn');
    expect(result.stderr).toContain('only import allowed session internal bridge');
  });

  it('rejects legacy root session imports from root DeepSeek provider helpers', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'session'), { recursive: true });
    mkdirSync(join(cwd, 'src', 'services'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'services', 'deepseek.ts'), 'export const deepseek = {};\n');
    writeFileSync(
      join(cwd, 'src', 'session', 'feature.ts'),
      "import { deepseek } from '../services/deepseek.js';\nexport { deepseek };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/session/feature.ts');
    expect(result.stderr).toContain('../services/deepseek.js');
    expect(result.stderr).toContain('@blade-ai/ai/deepseek');
  });

  it('rejects legacy root agent imports from root DeepSeek provider helpers', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'src', 'agent'), { recursive: true });
    mkdirSync(join(cwd, 'src', 'services'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'services', 'deepseek.ts'), 'export const deepseek = {};\n');
    writeFileSync(
      join(cwd, 'src', 'agent', 'feature.ts'),
      "import { deepseek } from '../services/deepseek.js';\nexport { deepseek };\n",
    );

    const result = spawnSync(process.execPath, [
      resolve('scripts/verify-package-boundaries.mjs'),
    ], {
      cwd,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/agent/feature.ts');
    expect(result.stderr).toContain('../services/deepseek.js');
    expect(result.stderr).toContain('@blade-ai/ai/deepseek');
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

  it('rejects source manifest targets that point at source files', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './src/index.ts',
      types: './src/index.ts',
      exports: {
        '.': {
          types: './src/index.ts',
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
    expect(result.stderr).toContain('source manifest target must not point at source files');
  });

  it('accepts new dist export targets when matching source build entries exist before build output', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser'), { recursive: true });
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'session'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser', 'index.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser', 'server-only-stub.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'session', 'internal.ts'), 'export {};\n');
    writeTsupConfig(join(cwd, 'packages', 'agent-sdk', 'tsup.config.ts'), {
      index: 'src/index.ts',
      'browser/index': 'src/browser/index.ts',
      'browser/server-only-stub': 'src/browser/server-only-stub.ts',
      'session/internal': 'src/session/internal.ts',
    });
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          browser: './dist/browser/index.js',
          import: './dist/index.js',
        },
        './session/internal': {
          types: './dist/session/internal.d.ts',
          browser: './dist/browser/server-only-stub.js',
          import: './dist/session/internal.js',
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

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('does not exist in package build output');
  });

  it('rejects manifest targets that only exist as stale dist files without source build entries', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'orphan'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'orphan', 'index.js'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'dist', 'orphan', 'index.d.ts'), 'export {};\n');
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './orphan': {
          types: './dist/orphan/index.d.ts',
          import: './dist/orphan/index.js',
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
    expect(result.stderr).toContain('export "./orphan" import target "./dist/orphan/index.js"');
    expect(result.stderr).toContain('source manifest target must be backed by a tsup source entry');
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

  it('rejects publish exports whose types condition is not first', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
        './tools': {
          import: './dist/tools/index.js',
          types: './dist/tools/index.d.ts',
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
    expect(result.stderr).toContain('export "." must declare the types condition first');
    expect(result.stderr).toContain('export "./tools" must declare the types condition first');
  });

  it('rejects unsupported public export conditions', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          require: './dist/index.cjs',
          import: './dist/index.js',
        },
        './server': {
          types: './dist/server/index.d.ts',
          node: './dist/server/index.js',
          import: './dist/server/index.js',
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
    expect(result.stderr).toContain('export "." condition "require" is not allowed');
    expect(result.stderr).toContain('export "./server" condition "node" is not allowed');
  });

  it('rejects browser export conditions that appear after import', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          browser: './dist/browser/index.js',
        },
        './server': {
          types: './dist/server/index.d.ts',
          import: './dist/server/index.js',
          browser: './dist/browser/server-only-stub.js',
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
    expect(result.stderr).toContain('export "." must declare the browser condition before import');
    expect(result.stderr).toContain('export "./server" must declare the browser condition before import');
  });

  it('rejects source SDK browser export conditions that do not point at browser-safe entries', () => {
    const cwd = createBoundaryFixture();
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser'), { recursive: true });
    mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', 'server'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'browser', 'index.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', 'server', 'index.ts'), 'export {};\n');
    writeTsupConfig(join(cwd, 'packages', 'agent-sdk', 'tsup.config.ts'), {
      index: 'src/index.ts',
      'browser/index': 'src/browser/index.ts',
      'server/index': 'src/server/index.ts',
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
        './server': {
          types: './dist/server/index.d.ts',
          browser: './dist/browser/index.js',
          import: './dist/server/index.js',
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
    expect(result.stderr).toContain('export "." browser condition must point at ./dist/browser/index.js');
    expect(result.stderr).toContain(
      'export "./server" browser condition must point at ./dist/browser/server-only-stub.js',
    );
  });

  it('requires browser-safe SDK subpaths to declare explicit browser conditions', () => {
    const cwd = createBoundaryFixture();
    for (const dir of ['browser', 'core', 'errors', 'tools']) {
      mkdirSync(join(cwd, 'packages', 'agent-sdk', 'src', dir), { recursive: true });
      writeFileSync(join(cwd, 'packages', 'agent-sdk', 'src', dir, 'index.ts'), 'export {};\n');
    }
    writeTsupConfig(join(cwd, 'packages', 'agent-sdk', 'tsup.config.ts'), {
      index: 'src/index.ts',
      'browser/index': 'src/browser/index.ts',
      'core/index': 'src/core/index.ts',
      'errors/index': 'src/errors/index.ts',
      'tools/index': 'src/tools/index.ts',
    });
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          browser: './dist/browser/index.js',
          import: './dist/index.js',
        },
        './browser': {
          types: './dist/browser/index.d.ts',
          import: './dist/browser/index.js',
        },
        './core': {
          types: './dist/core/index.d.ts',
          import: './dist/core/index.js',
        },
        './errors': {
          types: './dist/errors/index.d.ts',
          import: './dist/errors/index.js',
        },
        './tools': {
          types: './dist/tools/index.d.ts',
          import: './dist/tools/index.js',
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
    expect(result.stderr).toContain(
      'export "./browser" browser condition must point at ./dist/browser/index.js',
    );
    expect(result.stderr).toContain(
      'export "./core" browser condition must point at ./dist/core/index.js',
    );
    expect(result.stderr).toContain(
      'export "./errors" browser condition must point at ./dist/errors/index.js',
    );
    expect(result.stderr).toContain(
      'export "./tools" browser condition must point at ./dist/tools/index.js',
    );
  });

  it('rejects manifest targets with the wrong runtime artifact extension', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.d.ts',
      types: './dist/index.js',
      exports: {
        '.': {
          types: './dist/index.js',
          browser: './dist/browser/index.d.ts',
          import: './dist/index.d.ts',
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
    expect(result.stderr).toContain('main target "./dist/index.d.ts" must point at a .js runtime artifact');
    expect(result.stderr).toContain('types target "./dist/index.js" must point at a .d.ts declaration artifact');
    expect(result.stderr).toContain(
      'export "." types target "./dist/index.js" must point at a .d.ts declaration artifact',
    );
    expect(result.stderr).toContain(
      'export "." browser target "./dist/browser/index.d.ts" must point at a .js runtime artifact',
    );
    expect(result.stderr).toContain('export "." import target "./dist/index.d.ts" must point at a .js runtime artifact');
  });

  it('rejects source manifest targets that are not package-relative', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: {
        '.': {
          types: 'dist/index.d.ts',
          import: 'dist/index.js',
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
    expect(result.stderr).toContain('main target "dist/index.js"');
    expect(result.stderr).toContain('types target "dist/index.d.ts"');
    expect(result.stderr).toContain('source manifest target must stay package-relative');
  });

  it('rejects source manifest targets that escape the package directory', () => {
    const cwd = createBoundaryFixture();
    writeFileSync(join(cwd, 'packages', 'shared.js'), 'export {};\n');
    writeFileSync(join(cwd, 'packages', 'shared.d.ts'), 'export {};\n');
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/../../shared.js',
      types: './dist/../../shared.d.ts',
      exports: {
        '.': {
          types: './dist/../../shared.d.ts',
          import: './dist/../../shared.js',
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
    expect(result.stderr).toContain('main target "./dist/../../shared.js"');
    expect(result.stderr).toContain('types target "./dist/../../shared.d.ts"');
    expect(result.stderr).toContain('source manifest target must not escape the package');
  });

  it('rejects root entry fields that drift from the root export conditions', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/server/index.js',
      types: './dist/server/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
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
    expect(result.stderr).toContain(
      'main target "./dist/server/index.js" must match root export import target "./dist/index.js"',
    );
    expect(result.stderr).toContain(
      'types target "./dist/server/index.d.ts" must match root export types target "./dist/index.d.ts"',
    );
  });

  it('rejects publish manifests without root main and types fields', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
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
    expect(result.stderr).toContain('main field must declare a package root runtime entry');
    expect(result.stderr).toContain('types field must declare a package root declaration entry');
  });

  it('rejects publish manifests without a package metadata export', () => {
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
    expect(result.stderr).toContain('must expose "./package.json" metadata export');
  });

  it('rejects package metadata exports with extra conditions', () => {
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
          import: './dist/index.js',
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
    expect(result.stderr).toContain('metadata export must be exactly {"default":"./package.json"}');
  });

  it('rejects publish manifests without a root export condition object', () => {
    const cwd = createBoundaryFixture();
    writeJson(join(cwd, 'packages', 'agent-sdk', 'package.json'), {
      name: '@blade-ai/agent-sdk',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        './tools': {
          types: './dist/tools/index.d.ts',
          import: './dist/tools/index.js',
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
    expect(result.stderr).toContain('exports must declare a root "." condition object');
  });

  it('rejects public export subpaths with invalid package shapes', () => {
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
        server: {
          types: './dist/server/index.d.ts',
          import: './dist/server/index.js',
        },
        './../private': {
          types: './dist/private/index.d.ts',
          import: './dist/private/index.js',
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
    expect(result.stderr).toContain('export subpath "server" must be "." or start with "./"');
    expect(result.stderr).toContain('export subpath "./../private" must not contain parent directory segments');
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
