import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);

function readFunctionSource(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}`);
  if (start === -1) {
    throw new Error(`Missing function ${functionName}`);
  }
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return nextFunction === -1 ? source.slice(start) : source.slice(start, nextFunction);
}

describe('semantic-release configuration', () => {
  it('publishes only from main with v-prefixed tags', () => {
    const config = require('../../release.config.cjs');

    expect(config.branches).toEqual(['main']);
    expect(config.tagFormat).toBe('v${version}');
  });

  it('analyzes conventional commits, synchronizes workspace manifests, publishes all packages, then creates GitHub notes', () => {
    const config = require('../../release.config.cjs');

    expect(config.plugins).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      './scripts/semantic-release/monorepo-release-notes.cjs',
      './scripts/semantic-release/sync-workspace-versions.cjs',
      ['@semantic-release/npm', { pkgRoot: 'packages/ai' }],
      ['@semantic-release/npm', { pkgRoot: 'packages/agent' }],
      ['@semantic-release/npm', { pkgRoot: 'packages/agent-sdk' }],
      '@semantic-release/github',
    ]);
  });
});

describe('package provenance metadata', () => {
  it('keeps the workspace root as a private non-publishable orchestrator in the release gate', () => {
    const rootPackageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const releaseConfig = require('../../release.config.cjs');
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    const publishesRootPackage = releaseConfig.plugins.some((plugin: unknown) => {
      const isNpmPlugin = Array.isArray(plugin)
        ? plugin[0] === '@semantic-release/npm'
        : plugin === '@semantic-release/npm';
      const pkgRoot = Array.isArray(plugin) ? plugin[1]?.pkgRoot : undefined;

      return isNpmPlugin && (pkgRoot === undefined || pkgRoot === '.');
    });

    expect(rootPackageJson.private).toBe(true);
    expect(rootPackageJson.publishConfig).toBeUndefined();
    expect(rootPackageJson.files).toBeUndefined();
    expect(publishesRootPackage).toBe(false);
    expect(releaseVerifier).toContain('function verifyRootPackagePublishSafety');
    expect(releaseVerifier).toContain('root package.json must remain private');
    expect(releaseVerifier).toContain('root package.json must not declare publishConfig');
    expect(releaseVerifier).toContain('root package.json must not declare published files');
  });

  it('declares the GitHub repository URL and public npm publish config on every publishable package', () => {
    const packagePaths = [
      'packages/ai/package.json',
      'packages/agent/package.json',
      'packages/agent-sdk/package.json',
    ];

    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));

      expect(packageJson.private).toBe(false);
      expect(packageJson.repository).toEqual({
        type: 'git',
        url: 'https://github.com/echoVic/blade-agent-sdk',
      });
      expect(packageJson.publishConfig).toEqual({
        access: 'public',
        provenance: true,
        registry: 'https://registry.npmjs.org/',
      });
    }
  });

  it('keeps publishable package metadata and README files npm-friendly', () => {
    const packages = [
      {
        path: 'packages/ai',
        name: '@blade-ai/ai',
        requiredReadmeText: ['ModelPort', 'createOpenAICompatibleModelPort'],
      },
      {
        path: 'packages/agent',
        name: '@blade-ai/agent',
        requiredReadmeText: ['AgentKernel', 'runtime-independent'],
      },
      {
        path: 'packages/agent-sdk',
        name: '@blade-ai/agent-sdk',
        requiredReadmeText: ['createSession', 'session-first'],
      },
    ];
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    for (const pkg of packages) {
      const packageJson = JSON.parse(readFileSync(resolve(pkg.path, 'package.json'), 'utf8'));
      const readme = readFileSync(resolve(pkg.path, 'README.md'), 'utf8');

      expect(packageJson.license).toBe('MIT');
      expect(packageJson.engines).toEqual({ node: '>=22.14.0' });
      expect(packageJson.sideEffects).toBe(false);
      expect(packageJson.homepage).toBe('https://github.com/echoVic/blade-agent-sdk#readme');
      expect(packageJson.bugs).toEqual({
        url: 'https://github.com/echoVic/blade-agent-sdk/issues',
      });
      expect(packageJson.keywords).toEqual(expect.arrayContaining([
        'agent',
        'sdk',
        'llm',
      ]));
      if (pkg.name === '@blade-ai/agent-sdk') {
        expect(packageJson.keywords).not.toContain('cli');
      }
      expect(readme).toContain(pkg.name);
      for (const text of pkg.requiredReadmeText) {
        expect(readme).toContain(text);
      }
      expect(packageVerifier).toContain(`name: '${pkg.name}'`);
      expect(packageVerifier).toContain("'package/README.md'");
    }
  });

  it('keeps direct dependency versions exact in workspace manifests', () => {
    const packagePaths = [
      'package.json',
      'packages/ai/package.json',
      'packages/agent/package.json',
      'packages/agent-sdk/package.json',
    ];
    const dependencySections = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ];
    const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));

      for (const section of dependencySections) {
        for (const [dependencyName, dependencyVersion] of Object.entries(
          packageJson[section] ?? {}
        )) {
          const version = String(dependencyVersion);
          const isWorkspaceInternal = version === 'workspace:*' && dependencyName.startsWith('@blade-ai/');

          expect(
            isWorkspaceInternal || exactVersionPattern.test(version),
            `${packagePath} ${section}.${dependencyName} must use an exact version, got ${version}`
          ).toBe(true);
        }
      }
    }

    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    expect(releaseVerifier).toContain('verifyExactDirectDependencyVersions');
    expect(releaseVerifier).toContain('must use an exact dependency version');
  });

  it('keeps dependency build scripts behind a narrow pnpm allowlist', () => {
    const workspace = parse(readFileSync(resolve('pnpm-workspace.yaml'), 'utf8'));

    expect(workspace.allowBuilds).toEqual({
      '@vscode/ripgrep': true,
      esbuild: true,
      'node-pty': true,
    });

    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    expect(releaseVerifier).toContain('verifyPnpmWorkspaceSupplyChainPolicy');
    expect(releaseVerifier).toContain('allowBuilds');
    expect(releaseVerifier).toContain('pnpm-workspace.yaml allowBuilds must stay limited');
  });

  it('documents direct install and import usage in every publishable package README', () => {
    const packages = [
      {
        path: 'packages/ai',
        name: '@blade-ai/ai',
        importSnippet: "import { createOpenAICompatibleModelPort } from '@blade-ai/ai';",
      },
      {
        path: 'packages/agent',
        name: '@blade-ai/agent',
        importSnippet: "import { AgentKernel } from '@blade-ai/agent';",
      },
      {
        path: 'packages/agent-sdk',
        name: '@blade-ai/agent-sdk',
        importSnippet: "import { createSession } from '@blade-ai/agent-sdk';",
      },
    ];

    for (const pkg of packages) {
      const readme = readFileSync(resolve(pkg.path, 'README.md'), 'utf8');
      expect(readme).toContain(`pnpm add ${pkg.name}`);
      expect(readme).toContain(pkg.importSnippet);
    }
  });

  it('type-checks public package contracts from the packed temporary consumer', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain('function verifyConsumerTypes');
    expect(packageVerifier).toContain('consumer-types.ts');
    expect(packageVerifier).toContain('tsconfig.json');
    expect(packageVerifier).toContain('tsc');
    expect(packageVerifier).toContain('--noEmit');
    expect(packageVerifier).toContain("import { createOpenAICompatibleModelPort } from '@blade-ai/ai';");
    expect(packageVerifier).toContain("import { AgentKernel } from '@blade-ai/agent';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/kernel';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/protocol';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/ports';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/state';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/tracing';");
    expect(packageVerifier).toContain("import { createSession, defineTool, ToolKind } from '@blade-ai/agent-sdk';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/core';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/session';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/tools';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/local';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/server';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/browser';");
  });

  it('rejects server-only contracts from browser-safe core declarations', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain("file: 'package/dist/core/index.d.ts'");
    expect(packageVerifier).toContain("forbidden: 'createSession'");
    expect(packageVerifier).toContain("forbidden: 'resumeSession'");
    expect(packageVerifier).toContain("forbidden: 'forkSession'");
    expect(packageVerifier).toContain("forbidden: 'getBuiltinTools'");
    expect(packageVerifier).toContain("forbidden: 'createSdkMcpServer'");
    expect(packageVerifier).toContain('core declarations must stay browser-safe');
  });

  it('rejects node-local adapters from root package declarations', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain("file: 'package/dist/index.d.ts'");
    expect(packageVerifier).toContain("forbidden: 'getBuiltinTools'");
    expect(packageVerifier).toContain("forbidden: 'createSdkMcpServer'");
    expect(packageVerifier).toContain("forbidden: 'FileSystemMemoryStore'");
    expect(packageVerifier).toContain("forbidden: 'SandboxExecutor'");
    expect(packageVerifier).toContain('root declarations must keep Node-local builtin tools behind @blade-ai/agent-sdk/local');
  });

  it('rejects provider-specific helpers from root package declarations', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain("file: 'package/dist/index.d.ts'");
    expect(packageVerifier).toContain("forbidden: 'normalizeDeepSeekModel'");
    expect(packageVerifier).toContain("forbidden: 'calculateDeepSeekCost'");
    expect(packageVerifier).toContain("forbidden: 'DeepSeekCostTracker'");
    expect(packageVerifier).toContain("forbidden: 'DEEPSEEK_DEFAULT_MODEL'");
    expect(packageVerifier).toContain('root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek');
  });

  it('rejects server entry wildcard forwarding through the root facade', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    for (const verifier of [packageVerifier, publishedVerifier]) {
      expect(verifier).toContain("file: 'package/dist/server/index.js'");
      expect(verifier).toContain("file: 'package/dist/server/index.d.ts'");
      expect(verifier).toContain('server runtime entry must be an explicit package-local facade');
      expect(verifier).toContain('server declarations must be an explicit package-local facade');
    }
  });

  it('type-checks server facade parity with the public root surface', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    for (const verifier of [packageVerifier, publishedVerifier]) {
      expect(verifier).toContain('function assertRuntimeExportParity');
      expect(verifier).toContain("assertRuntimeExportParity(agentSdk, agentSdkServer, 'root', 'server')");
      expect(verifier).toContain('function assertDeclarationExportParity');
      expect(verifier).toContain("'node_modules/@blade-ai/agent-sdk/dist/index.d.ts'");
      expect(verifier).toContain("'node_modules/@blade-ai/agent-sdk/dist/server/index.d.ts'");
      expect(verifier).toContain("assertDeclarationExportParity(rootDeclaration, serverDeclaration, 'root', 'server')");
      expect(verifier).toContain('subagentRegistry');
      expect(verifier).toContain('ClaudeCodePermissionMode');
      expect(verifier).toContain('SubagentExecutionRunner');
      expect(verifier).toContain('SubagentFrontmatter');
      expect(verifier).toContain('PermissionsConfig');
    }
  });

  it('runtime-loads public value exports from the packed temporary consumer', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain('consumer-runtime.mjs');
    expect(packageVerifier).toContain('function assertRuntimeExport');
    expect(packageVerifier).toContain("import aiPackage from '@blade-ai/ai/package.json'");
    expect(packageVerifier).toContain("import agentPackage from '@blade-ai/agent/package.json'");
    expect(packageVerifier).toContain("import agentSdkPackage from '@blade-ai/agent-sdk/package.json'");
    expect(packageVerifier).toContain("assertPackageName(aiPackage, '@blade-ai/ai')");
    expect(packageVerifier).toContain("assertPackageName(agentPackage, '@blade-ai/agent')");
    expect(packageVerifier).toContain("assertPackageName(agentSdkPackage, '@blade-ai/agent-sdk')");
    expect(packageVerifier).toContain("import * as aiChat from '@blade-ai/ai/chat';");
    expect(packageVerifier).toContain("import * as aiModel from '@blade-ai/ai/model';");
    expect(packageVerifier).toContain("assertRuntimeExport(ai, 'createOpenAICompatibleModelPort')");
    expect(packageVerifier).toContain("assertRuntimeExport(aiRetry, 'DEFAULT_RETRY_CONFIG')");
    expect(packageVerifier).toContain("assertRuntimeExport(agent, 'AgentKernel')");
    expect(packageVerifier).toContain("assertRuntimeExport(agentKernel, 'AgentKernel')");
    expect(packageVerifier).toContain("assertRuntimeExport(agentSdk, 'createSession')");
    expect(packageVerifier).toContain("assertRuntimeExport(agentSdk, 'defineTool')");
    expect(packageVerifier).toContain("assertNoRuntimeExport(agentSdk, 'getBuiltinTools')");
    expect(packageVerifier).toContain("assertNoRuntimeExport(agentSdk, 'createSdkMcpServer')");
    expect(packageVerifier).toContain("assertNoRuntimeExport(agentSdk, 'normalizeDeepSeekModel')");
    expect(packageVerifier).toContain("assertNoRuntimeExport(agentSdk, 'DeepSeekCostTracker')");
    expect(packageVerifier).toContain("assertRuntimeExport(agentSdkTools, 'ToolKind')");
    expect(packageVerifier).toContain("throw new Error('@blade-ai/ai/chat should remain type-only at runtime')");
  });

  it('type-checks exported AI provider subpaths from the packed temporary consumer', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain("'@blade-ai/ai/chat'");
    expect(packageVerifier).toContain("'@blade-ai/ai/model'");
    expect(packageVerifier).toContain("'@blade-ai/ai/retry'");
    expect(packageVerifier).toContain("'@blade-ai/ai/deepseek'");
    expect(packageVerifier).toContain("'@blade-ai/ai/providers/openai-compatible'");
    expect(packageVerifier).toContain("'@blade-ai/ai/providers/vercel'");
    expect(packageVerifier).toContain("from '@blade-ai/ai/chat';");
    expect(packageVerifier).toContain("from '@blade-ai/ai/model';");
    expect(packageVerifier).toContain("from '@blade-ai/ai/retry';");
    expect(packageVerifier).toContain("from '@blade-ai/ai/deepseek';");
    expect(packageVerifier).toContain("from '@blade-ai/ai/providers/openai-compatible';");
    expect(packageVerifier).toContain("from '@blade-ai/ai/providers/vercel';");
  });

  it('bundles browser-safe entrypoints from the packed temporary consumer', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const esbuildHelper = readFileSync(resolve('scripts/esbuild-bundle.mjs'), 'utf8');

    expect(packageVerifier).toContain("import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';");
    expect(packageVerifier).toContain('function verifyConsumerBrowserBundle');
    expect(packageVerifier).toContain('consumer-browser-entry.ts');
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/session';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/server';");
    expect(packageVerifier).toContain("from '@blade-ai/agent-sdk/local';");
    expect(packageVerifier).toContain('await bundleWithEsbuildRetry({');
    expect(esbuildHelper).toContain("import { build as bundleWithEsbuild, stop as stopEsbuildService } from 'esbuild';");
    expect(esbuildHelper).toContain('const resetService = config.resetService ?? stopEsbuildService;');
    expect(esbuildHelper).toContain('resetService();');
    expect(esbuildHelper).toContain('The service was stopped');
    expect(packageVerifier).toContain("platform: 'browser'");
    expect(packageVerifier).toContain("conditions: ['browser']");
    expect(packageVerifier).not.toContain("resolve(repoRoot, 'node_modules/.bin/esbuild')");
    expect(packageVerifier).toContain('assertNoBrowserDisallowedMarkers');
    expect(packageVerifier).toContain('server-only for createSession');
    expect(packageVerifier).toContain('server-only for resumeSession');
    expect(packageVerifier).toContain('server-only for getBuiltinTools');
  });

  it('browser-bundles the packed runtime-independent agent package', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');

    expect(packageVerifier).toContain('function verifyAgentBrowserBundle');
    expect(packageVerifier).toContain('consumer-agent-browser-entry.ts');
    expect(packageVerifier).toContain("from '@blade-ai/agent';");
    expect(packageVerifier).toContain("from '@blade-ai/agent/kernel';");
    expect(packageVerifier).toContain('agent browser bundle');
    expect(packageVerifier).toContain('assertNoBrowserDisallowedMarkers(agentBundleOutput)');
  });
});

describe('release scripts', () => {
  it('runs release configuration verification in the main production gate', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.scripts['verify:release']).toBe('node scripts/verify-release-config.mjs');
    expect(packageJson.scripts.verify).toContain(
      'pnpm run verify:packages && pnpm run verify:release && pnpm run test:unit'
    );
  });

  it('keeps a semantic-release dry-run command for tokened release rehearsal without publishing', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.scripts['release:dry']).toBe('semantic-release --dry-run --no-ci');
  });

  it('does not expose the retired manual release script path', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(packageJson.scripts).not.toHaveProperty('release:legacy');
    expect(packageJson.scripts).not.toHaveProperty('release:manual');
    expect(JSON.stringify(packageJson.scripts)).not.toContain('scripts/release.js');
    expect(existsSync(resolve('scripts/release.js'))).toBe(false);
    expect(existsSync(resolve('scripts/release-utils.js'))).toBe(false);
    expect(releaseVerifier).toContain('release:legacy');
    expect(releaseVerifier).toContain('scripts/release.js');
    expect(releaseVerifier).toContain('release-utils.js');
  });

  it('documents the GitHub token requirement for semantic-release dry runs', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8');

    expect(readme).toContain('GITHUB_TOKEN');
    expect(readme).toContain('GH_TOKEN');
    expect(readme).toContain('@blade-ai/ai');
    expect(readme).toContain('@blade-ai/agent');
    expect(readme).toContain('@blade-ai/agent-sdk');
  });

  it('generates per-package release notes for the fixed-version monorepo release', async () => {
    const { generateMonorepoReleaseNotes } = require('../../scripts/semantic-release/monorepo-release-notes.cjs');

    const notes = await generateMonorepoReleaseNotes({
      nextRelease: { version: '2.3.4' },
    });

    expect(notes).toContain('## Published packages');
    expect(notes).toContain('@blade-ai/ai@2.3.4');
    expect(notes).toContain('@blade-ai/agent@2.3.4');
    expect(notes).toContain('@blade-ai/agent-sdk@2.3.4');
    expect(notes).toContain('Provider-agnostic model runtime');
    expect(notes).toContain('Runtime-independent agent kernel');
    expect(notes).toContain('Session-first product SDK');
    expect(notes).toContain('pnpm add @blade-ai/agent-sdk@2.3.4');
  });

  it('synchronizes workspace package versions and internal dependencies before npm publish', async () => {
    const { syncWorkspaceVersions } = require('../../scripts/semantic-release/sync-workspace-versions.cjs');
    const cwd = mkdtempSync(join(tmpdir(), 'blade-release-sync-'));
    const packages = ['ai', 'agent', 'agent-sdk'];

    for (const packageName of packages) {
      const packageDir = join(cwd, 'packages', packageName);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: `@blade-ai/${packageName}`,
          version: '0.0.0',
          dependencies: packageName === 'ai'
            ? { zod: '^3.25.0' }
            : { '@blade-ai/ai': 'workspace:*' },
          optionalDependencies: packageName === 'agent-sdk'
            ? { '@blade-ai/agent': 'workspace:*' }
            : undefined,
        }, null, 2),
      );
    }

    await syncWorkspaceVersions({
      cwd,
      nextRelease: { version: '2.3.4' },
    });

    for (const packageName of packages) {
      const manifest = JSON.parse(
        readFileSync(join(cwd, 'packages', packageName, 'package.json'), 'utf8'),
      );
      expect(manifest.version).toBe('2.3.4');
      expect(JSON.stringify(manifest)).not.toContain('workspace:');
      if (packageName === 'agent') {
        expect(manifest.dependencies['@blade-ai/ai']).toBe('2.3.4');
      }
      if (packageName === 'agent-sdk') {
        expect(manifest.dependencies['@blade-ai/ai']).toBe('2.3.4');
        expect(manifest.optionalDependencies['@blade-ai/agent']).toBe('2.3.4');
      }
    }
  });

  it('verifies prepared release manifests from the real package metadata', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain('verifyPreparedReleaseManifestVersions');
    expect(releaseVerifier).toContain('syncWorkspaceVersions');
    expect(releaseVerifier).toContain('123.45.67');
    expect(releaseVerifier).toContain('prepared manifest');
    expect(releaseVerifier).toContain('workspace:');
    expect(releaseVerifier).toContain('0.0.0');
  });

  it('requires npm provenance in publishable package metadata', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain('provenance');
    expect(releaseVerifier).toContain('publishConfig');
  });

  it('requires ESM and side-effect-free metadata in the release verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain("manifest.type !== 'module'");
    expect(releaseVerifier).toContain('manifest.sideEffects !== false');
    expect(releaseVerifier).toContain('must be ESM-only');
    expect(releaseVerifier).toContain('must declare sideEffects false');
  });

  it('requires a narrow publish files whitelist in the release verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain('publishFiles');
    expect(releaseVerifier).toContain('manifest.files');
    expect(releaseVerifier).toContain("'vendor/ripgrep/**'");
    expect(releaseVerifier).toContain('published files');
  });

  it('requires npm discoverability metadata in the release verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain('manifest.homepage');
    expect(releaseVerifier).toContain('manifest.bugs');
    expect(releaseVerifier).toContain('manifest.keywords');
    expect(releaseVerifier).toContain('homepage');
    expect(releaseVerifier).toContain('keywords');
  });

  it('requires package README install and import snippets in the release verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(releaseVerifier).toContain("installCommand: 'pnpm add @blade-ai/ai'");
    expect(releaseVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent'");
    expect(releaseVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent-sdk'");
    expect(releaseVerifier).toContain("importSnippet: \"import { createOpenAICompatibleModelPort } from '@blade-ai/ai';\"");
    expect(releaseVerifier).toContain("importSnippet: \"import { AgentKernel } from '@blade-ai/agent';\"");
    expect(releaseVerifier).toContain("importSnippet: \"import { createSession } from '@blade-ai/agent-sdk';\"");
    expect(releaseVerifier).toContain('README must document direct installation');
    expect(releaseVerifier).toContain('README must document direct import usage');
    expect(roadmap).toContain('release verifier now rejects package READMEs without direct install/import snippets');
  });

  it('verifies npm provenance attestations after packages are published', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyNpmPackageProvenance');
    expect(publishedVerifier).toContain('dist.attestations.provenance.predicateType');
    expect(publishedVerifier).toContain('https://slsa.dev/provenance/v1');
    expect(readme).toContain('npm provenance attestations');
    expect(checklist).toContain('npm provenance attestations');
  });

  it('verifies npm latest dist-tags and registry tarball integrity after packages are published', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyNpmLatestDistTag');
    expect(publishedVerifier).toContain('dist-tags');
    expect(publishedVerifier).toContain('verifyNpmPackageTarballIntegrity');
    expect(publishedVerifier).toContain('metadata.dist.integrity');
    expect(publishedVerifier).toContain('metadata.dist.shasum');
    expect(publishedVerifier).toContain('ssri');
    expect(readme).toContain('npm latest dist-tag');
    expect(readme).toContain('registry tarball integrity');
    expect(checklist).toContain('npm latest dist-tag');
    expect(checklist).toContain('registry tarball integrity');
  });

  it('exposes a post-publish verifier for GitHub Release and npm package visibility', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(packageJson.scripts['verify:published']).toBe('node scripts/verify-published.mjs');
    expect(existsSync(resolve('scripts/verify-published.mjs'))).toBe(true);
    expect(readme).toContain('pnpm run verify:published -- --version');
    expect(checklist).toContain('pnpm run verify:published -- --version');
  });

  it('verifies published packages by installing them into a temporary consumer', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedInstallSmoke');
    expect(publishedVerifier).toContain('mkdtemp');
    expect(publishedVerifier).toContain('consumer-runtime.mjs');
    expect(publishedVerifier).toContain('npm install');
    expect(publishedVerifier).toContain('@blade-ai/ai@${version}');
    expect(publishedVerifier).toContain('@blade-ai/agent@${version}');
    expect(publishedVerifier).toContain('@blade-ai/agent-sdk@${version}');
    expect(publishedVerifier).toContain("assertRuntimeExport(agentSdk, 'createSession')");
    expect(publishedVerifier).toContain("assertNoRuntimeExport(agentSdk, 'getBuiltinTools')");
    expect(publishedVerifier).toContain("assertNoRuntimeExport(agentSdk, 'createSdkMcpServer')");
    expect(publishedVerifier).toContain("assertNoRuntimeExport(agentSdk, 'normalizeDeepSeekModel')");
    expect(publishedVerifier).toContain("assertNoRuntimeExport(agentSdk, 'DeepSeekCostTracker')");
    expect(publishedVerifier).toContain("assertRuntimeExport(agentSdkServer, 'createSession')");
    expect(publishedVerifier).toContain("assertRuntimeExport(agentSdkLocal, 'getBuiltinTools')");
    expect(publishedVerifier).toContain("assertRuntimeExport(agentSdkBrowser, 'PermissionMode')");
    expect(readme).toContain('临时 consumer');
    expect(checklist).toContain('临时 consumer');
  });

  it('verifies published package READMEs from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('publishedReadmeRequirements');
    expect(publishedVerifier).toContain('verifyPublishedReadmes');
    expect(publishedVerifier).toContain("node_modules/@blade-ai/ai/README.md");
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent/README.md");
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent-sdk/README.md");
    expect(publishedVerifier).toContain("installCommand: 'pnpm add @blade-ai/ai'");
    expect(publishedVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent'");
    expect(publishedVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent-sdk'");
    expect(publishedVerifier).toContain("importSnippet: \"import { createOpenAICompatibleModelPort } from '@blade-ai/ai';\"");
    expect(publishedVerifier).toContain("importSnippet: \"import { AgentKernel } from '@blade-ai/agent';\"");
    expect(publishedVerifier).toContain("importSnippet: \"import { createSession } from '@blade-ai/agent-sdk';\"");
    expect(publishedVerifier).toContain('published README must document direct installation');
    expect(publishedVerifier).toContain('published README must document direct import usage');
    expect(checklist).toContain('published package READMEs');
    expect(roadmap).toContain('published package README gate');
  });

  it('verifies packed package READMEs before publication', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('packedReadmeRequirements');
    expect(packageVerifier).toContain('verifyPackedReadmes');
    expect(packageVerifier).toContain("'package/README.md'");
    expect(packageVerifier).toContain("installCommand: 'pnpm add @blade-ai/ai'");
    expect(packageVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent'");
    expect(packageVerifier).toContain("installCommand: 'pnpm add @blade-ai/agent-sdk'");
    expect(packageVerifier).toContain("importSnippet: \"import { createOpenAICompatibleModelPort } from '@blade-ai/ai';\"");
    expect(packageVerifier).toContain("importSnippet: \"import { AgentKernel } from '@blade-ai/agent';\"");
    expect(packageVerifier).toContain("importSnippet: \"import { createSession } from '@blade-ai/agent-sdk';\"");
    expect(packageVerifier).toContain('packed README must document direct installation');
    expect(packageVerifier).toContain('packed README must document direct import usage');
    expect(readme).toContain('packed package READMEs');
    expect(checklist).toContain('packed package READMEs');
    expect(roadmap).toContain('packed package README gate');
  });

  it('verifies packed and published package license artifacts', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    for (const packagePath of [
      'packages/ai/package.json',
      'packages/agent/package.json',
      'packages/agent-sdk/package.json',
    ]) {
      const packageJson = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));
      expect(packageJson.files).toContain('LICENSE');
      expect(existsSync(resolve(dirname(packagePath), 'LICENSE'))).toBe(true);
    }

    expect(releaseVerifier).toContain("'LICENSE'");
    expect(releaseVerifier).toContain('LICENSE must include the MIT permission grant');
    expect(packageVerifier).toContain("'package/LICENSE'");
    expect(packageVerifier).toContain('verifyPackedLicenseArtifacts');
    expect(packageVerifier).toContain('packed LICENSE must include the MIT permission grant');
    expect(publishedVerifier).toContain('verifyPublishedLicenseArtifacts');
    expect(publishedVerifier).toContain("node_modules/@blade-ai/ai/LICENSE");
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent/LICENSE");
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent-sdk/LICENSE");
    expect(publishedVerifier).toContain('published LICENSE must include the MIT permission grant');
    expect(readme).toContain('packed package license artifacts');
    expect(readme).toContain('published package license artifacts');
    expect(checklist).toContain('packed package license artifacts');
    expect(checklist).toContain('published package license artifacts');
    expect(roadmap).toContain('package license artifact gate');
  });

  it('verifies installed published package manifests from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('publishedManifestRequirements');
    expect(publishedVerifier).toContain('verifyPublishedPackageManifests');
    expect(publishedVerifier).toContain("manifestPath: 'node_modules/@blade-ai/ai/package.json'");
    expect(publishedVerifier).toContain("manifestPath: 'node_modules/@blade-ai/agent/package.json'");
    expect(publishedVerifier).toContain("manifestPath: 'node_modules/@blade-ai/agent-sdk/package.json'");
    expect(publishedVerifier).toContain('installed manifest version mismatch');
    expect(publishedVerifier).toContain('installed manifest must not contain workspace: dependencies');
    expect(publishedVerifier).toContain('installed manifest must not contain 0.0.0 placeholder versions');
    expect(publishedVerifier).toContain('internal dependency');
    expect(publishedVerifier).toContain('must match published version');
    expect(checklist).toContain('published package manifests');
    expect(roadmap).toContain('published package manifest gate');
  });

  it('rejects CLI product entrypoints from packed and published library manifests', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    for (const verifier of [packageVerifier, publishedVerifier]) {
      const helperSource = readFunctionSource(verifier, 'assertNoCliProductManifest');

      expect(helperSource).not.toContain("packageName !== '@blade-ai/agent-sdk'");
      expect(helperSource).toContain('${packageName} manifest must not publish a bin field');
      expect(helperSource).toContain('${packageName} manifest must not publish a ./cli export');
      expect(helperSource).toContain('${packageName} manifest must not publish CLI product keyword');
      expect(helperSource).toContain('manifest.keywords');
      expect(helperSource).toContain('CLI product capabilities belong in a separate package');
    }
  });

  it('verifies published package npm metadata from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedPackageMetadata');
    expect(publishedVerifier).toContain('installed manifest license mismatch');
    expect(publishedVerifier).toContain('installed manifest homepage mismatch');
    expect(publishedVerifier).toContain('installed manifest bugs mismatch');
    expect(publishedVerifier).toContain('installed manifest repository mismatch');
    expect(publishedVerifier).toContain("license: 'MIT'");
    expect(publishedVerifier).toContain("homepage: 'https://github.com/echoVic/blade-agent-sdk#readme'");
    expect(publishedVerifier).toContain("url: 'https://github.com/echoVic/blade-agent-sdk/issues'");
    expect(publishedVerifier).toContain("url: 'https://github.com/echoVic/blade-agent-sdk'");
    expect(checklist).toContain('published package npm metadata');
    expect(roadmap).toContain('published package npm metadata gate');
  });

  it('verifies packed package npm metadata before publication', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('verifyPackedPackageMetadata');
    expect(packageVerifier).toContain('packed manifest license mismatch');
    expect(packageVerifier).toContain('packed manifest homepage mismatch');
    expect(packageVerifier).toContain('packed manifest bugs mismatch');
    expect(packageVerifier).toContain('packed manifest repository mismatch');
    expect(packageVerifier).toContain("license: 'MIT'");
    expect(packageVerifier).toContain("homepage: 'https://github.com/echoVic/blade-agent-sdk#readme'");
    expect(packageVerifier).toContain("url: 'https://github.com/echoVic/blade-agent-sdk/issues'");
    expect(packageVerifier).toContain("url: 'https://github.com/echoVic/blade-agent-sdk'");
    expect(readme).toContain('packed package npm metadata');
    expect(checklist).toContain('packed package npm metadata');
    expect(roadmap).toContain('package npm metadata gate');
  });

  it('verifies packed and published package description metadata', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(releaseVerifier).toContain("description: 'Provider-agnostic AI model interfaces for Blade Agent'");
    expect(releaseVerifier).toContain("description: 'Runtime-independent Blade Agent kernel contracts'");
    expect(releaseVerifier).toContain("description: 'Session-first Blade Agent SDK'");
    expect(releaseVerifier).toContain('must declare package description');
    expect(packageVerifier).toContain('packed manifest description mismatch');
    expect(packageVerifier).toContain("expectedDescription: 'Provider-agnostic AI model interfaces for Blade Agent'");
    expect(packageVerifier).toContain("expectedDescription: 'Runtime-independent Blade Agent kernel contracts'");
    expect(packageVerifier).toContain("expectedDescription: 'Session-first Blade Agent SDK'");
    expect(publishedVerifier).toContain('installed manifest description mismatch');
    expect(publishedVerifier).toContain("description: 'Provider-agnostic AI model interfaces for Blade Agent'");
    expect(publishedVerifier).toContain("description: 'Runtime-independent Blade Agent kernel contracts'");
    expect(publishedVerifier).toContain("description: 'Session-first Blade Agent SDK'");
    expect(readme).toContain('packed package description metadata');
    expect(readme).toContain('published package description metadata');
    expect(checklist).toContain('packed package description metadata');
    expect(checklist).toContain('published package description metadata');
    expect(roadmap).toContain('package description metadata artifact gate');
  });

  it('verifies packed and published package author metadata', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    for (const packagePath of [
      'packages/ai/package.json',
      'packages/agent/package.json',
      'packages/agent-sdk/package.json',
    ]) {
      const packageJson = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));
      expect(packageJson.author).toBe('echoVic');
    }

    expect(releaseVerifier).toContain("author: 'echoVic'");
    expect(releaseVerifier).toContain('must declare package author');
    expect(packageVerifier).toContain('packed manifest author mismatch');
    expect(packageVerifier).toContain("author: 'echoVic'");
    expect(publishedVerifier).toContain('installed manifest author mismatch');
    expect(publishedVerifier).toContain("author: 'echoVic'");
    expect(readme).toContain('packed package author metadata');
    expect(readme).toContain('published package author metadata');
    expect(checklist).toContain('packed package author metadata');
    expect(checklist).toContain('published package author metadata');
    expect(roadmap).toContain('package author metadata artifact gate');
  });

  it('verifies packed and published package artifact size budgets', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('maxPackedBytes');
    expect(packageVerifier).toContain('packed tarball exceeds size budget');
    expect(packageVerifier).toContain('statSync(tarballPath).size');

    expect(publishedVerifier).toContain('maxInstalledBytes');
    expect(publishedVerifier).toContain('installed package exceeds size budget');
    expect(publishedVerifier).toContain('calculateDirectorySizeBytes');

    expect(readme).toContain('packed package size budgets');
    expect(readme).toContain('published package size budgets');
    expect(checklist).toContain('packed package size budgets');
    expect(checklist).toContain('published package size budgets');
    expect(roadmap).toContain('package artifact size budget gate');
  });

  it('verifies packed and published package engine metadata', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('packed manifest node engine mismatch');
    expect(packageVerifier).toContain("engines: { node: '>=22.14.0' }");
    expect(publishedVerifier).toContain('installed manifest node engine mismatch');
    expect(publishedVerifier).toContain("engines: { node: '>=22.14.0' }");
    expect(readme).toContain('packed package engine metadata');
    expect(readme).toContain('published package engine metadata');
    expect(checklist).toContain('packed package engine metadata');
    expect(checklist).toContain('published package engine metadata');
    expect(roadmap).toContain('package engine metadata artifact gate');
  });

  it('verifies packed and published package module metadata', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('packed manifest type module mismatch');
    expect(packageVerifier).toContain('packed manifest sideEffects mismatch');
    expect(packageVerifier).toContain("type: 'module'");
    expect(packageVerifier).toContain('sideEffects: false');
    expect(publishedVerifier).toContain('installed manifest type module mismatch');
    expect(publishedVerifier).toContain('installed manifest sideEffects mismatch');
    expect(publishedVerifier).toContain("type: 'module'");
    expect(publishedVerifier).toContain('sideEffects: false');
    expect(readme).toContain('packed package module metadata');
    expect(readme).toContain('published package module metadata');
    expect(checklist).toContain('packed package module metadata');
    expect(checklist).toContain('published package module metadata');
    expect(roadmap).toContain('package module metadata artifact gate');
  });

  it('verifies packed and published package discoverability metadata', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    for (const verifier of [packageVerifier, publishedVerifier]) {
      expect(verifier).toContain("requiredPackageKeywords = ['agent', 'sdk', 'llm']");
      expect(verifier).toContain('for (const keyword of requiredPackageKeywords)');
      expect(verifier).toContain('manifest.keywords?.includes(keyword)');
    }
    expect(packageVerifier).toContain('packed manifest keywords must include');
    expect(publishedVerifier).toContain('installed manifest keywords must include');
    expect(readme).toContain('packed package discoverability metadata');
    expect(readme).toContain('published package discoverability metadata');
    expect(checklist).toContain('packed package discoverability metadata');
    expect(checklist).toContain('published package discoverability metadata');
    expect(roadmap).toContain('package discoverability metadata artifact gate');
  });

  it('verifies packed package manifest entry targets before publication', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('assertPackedManifestTarget');
    expect(packageVerifier).toContain("label: 'main'");
    expect(packageVerifier).toContain("label: 'types'");
    expect(packageVerifier).toContain("label: `exports.${exportName}.${condition}`");
    expect(packageVerifier).toContain('packed manifest target must point at ./dist/');
    expect(packageVerifier).toContain('packed manifest target must not point at source files');
    expect(packageVerifier).toContain('packed manifest target must stay package-relative');
    expect(packageVerifier).toContain('packed manifest target must not escape the package');
    expect(packageVerifier).toContain("target === './package.json'");
    expect(readme).toContain('packed package manifest entry targets');
    expect(checklist).toContain('packed package manifest entry targets');
    expect(roadmap).toContain('packed package manifest entry target gate');
  });

  it('verifies packed SDK browser export conditions before publication', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('verifyPackedSdkBrowserExportConditions');
    expect(packageVerifier).toContain("'.': './dist/browser/index.js'");
    expect(packageVerifier).toContain("'./server': './dist/browser/server-only-stub.js'");
    expect(packageVerifier).toContain("'./session': './dist/browser/server-only-stub.js'");
    expect(packageVerifier).toContain("'./local': './dist/browser/server-only-stub.js'");
    expect(packageVerifier).toContain('packed SDK export');
    expect(packageVerifier).toContain('browser condition mismatch');
    expect(packageVerifier).toContain('must keep an import condition alongside the browser condition');
    expect(readme).toContain('packed SDK browser export conditions');
    expect(checklist).toContain('packed SDK browser export conditions');
    expect(roadmap).toContain('packed SDK browser export condition gate');
  });

  it('verifies packed package file scope before publication', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('tarball includes source files');
    expect(packageVerifier).toContain("entry.includes('/src/')");
    expect(packageVerifier).toContain("entry.startsWith('package/src/')");
    expect(readme).toContain('packed package file scope');
    expect(checklist).toContain('packed package file scope');
    expect(roadmap).toContain('packed package file-scope gate');
  });

  it('verifies packed and published package TypeScript artifact scope', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('tarball includes TypeScript source artifacts');
    expect(packageVerifier).toContain('isTypeScriptSourceArtifact');
    expect(packageVerifier).toContain('isTypeScriptBuildConfigArtifact');
    expect(publishedVerifier).toContain('installed package includes TypeScript source artifacts');
    expect(publishedVerifier).toContain('isTypeScriptSourceArtifact');
    expect(publishedVerifier).toContain('isTypeScriptBuildConfigArtifact');
    expect(readme).toContain('TypeScript artifact scope');
    expect(checklist).toContain('TypeScript artifact scope');
    expect(roadmap).toContain('TypeScript artifact-scope gate');
  });

  it('verifies packed and published package artifact allowlists', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(packageVerifier).toContain('assertAllowedPackageArtifact');
    expect(packageVerifier).toContain('tarball includes an unexpected package artifact');
    expect(packageVerifier).toContain("'package/vendor/ripgrep/'");
    expect(publishedVerifier).toContain('assertAllowedPackageArtifact');
    expect(publishedVerifier).toContain('installed package includes an unexpected package artifact');
    expect(publishedVerifier).toContain("'vendor/ripgrep/'");
    expect(readme).toContain('package artifact allowlist');
    expect(checklist).toContain('package artifact allowlist');
    expect(roadmap).toContain('package artifact allowlist gate');
  });

  it('verifies published package manifest entry targets from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('assertPublishedManifestTarget');
    expect(publishedVerifier).toContain("label: 'main'");
    expect(publishedVerifier).toContain("label: 'types'");
    expect(publishedVerifier).toContain("label: `exports.${exportName}.${condition}`");
    expect(publishedVerifier).toContain('installed manifest target must point at ./dist/');
    expect(publishedVerifier).toContain('installed manifest target must not point at source files');
    expect(publishedVerifier).toContain('installed manifest target must stay package-relative');
    expect(publishedVerifier).toContain('installed manifest target must not escape the package');
    expect(publishedVerifier).toContain("target === './package.json'");
    expect(checklist).toContain('published package manifest entry targets');
    expect(roadmap).toContain('published package manifest entry target gate');
  });

  it('verifies published SDK browser export conditions from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedSdkBrowserExportConditions');
    expect(publishedVerifier).toContain("'.': './dist/browser/index.js'");
    expect(publishedVerifier).toContain("'./server': './dist/browser/server-only-stub.js'");
    expect(publishedVerifier).toContain("'./session': './dist/browser/server-only-stub.js'");
    expect(publishedVerifier).toContain("'./local': './dist/browser/server-only-stub.js'");
    expect(publishedVerifier).toContain('published SDK export');
    expect(publishedVerifier).toContain('browser condition mismatch');
    expect(publishedVerifier).toContain('must keep an import condition alongside the browser condition');
    expect(readme).toContain('published SDK browser export conditions');
    expect(checklist).toContain('published SDK browser export conditions');
    expect(roadmap).toContain('published SDK browser export condition gate');
  });

  it('verifies published package installed file scope from the temporary consumer install', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedPackageFileScope');
    expect(publishedVerifier).toContain("run('find'");
    expect(publishedVerifier).toContain("'.d.ts.map'");
    expect(publishedVerifier).toContain("'.js.map'");
    expect(publishedVerifier).toContain("includes('/__tests__/')");
    expect(publishedVerifier).toContain("/\\.(test|spec)\\.[cm]?[jt]s$/");
    expect(publishedVerifier).toContain("includes('/src/')");
    expect(publishedVerifier).toContain('installed package includes a declaration map');
    expect(publishedVerifier).toContain('installed package includes a JavaScript source map');
    expect(publishedVerifier).toContain('installed package includes a test file');
    expect(publishedVerifier).toContain('installed package includes source files');
    expect(checklist).toContain('published package file scope');
    expect(roadmap).toContain('published package file-scope gate');
  });

  it('rejects CLI product files from packed and published library artifacts', () => {
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const packageHelperSource = readFunctionSource(packageVerifier, 'assertNoCliProductFiles');
    const publishedHelperSource = readFunctionSource(publishedVerifier, 'assertNoCliProductFiles');

    expect(packageHelperSource).toContain("entry.startsWith('package/dist/cli/')");
    expect(packageHelperSource).not.toContain("packageName !== '@blade-ai/agent-sdk'");
    expect(packageHelperSource).toContain('${packageName} tarball includes CLI product files');

    expect(publishedHelperSource).toContain("filePath.startsWith('dist/cli/')");
    expect(publishedHelperSource).not.toContain("packageName !== '@blade-ai/agent-sdk'");
    expect(publishedHelperSource).toContain('${packageName} installed package includes CLI product files');
  });

  it('type-checks public declarations from the published temporary consumer', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedTypesSmoke');
    expect(publishedVerifier).toContain('consumer-types.ts');
    expect(publishedVerifier).toContain('tsconfig.json');
    expect(publishedVerifier).toContain('tsc');
    expect(publishedVerifier).toContain('--noEmit');
    expect(publishedVerifier).toContain("import type { ModelPort } from '@blade-ai/ai';");
    expect(publishedVerifier).toContain("import type { AgentKernelOptions } from '@blade-ai/agent';");
    expect(publishedVerifier).toContain("import type { SessionOptions } from '@blade-ai/agent-sdk';");
    expect(readme).toContain('TypeScript public declarations');
    expect(checklist).toContain('TypeScript public declarations');
  });

  it('guards session model sampling and budget options across public docs and type smokes', () => {
    const sessionTypes = readFileSync(resolve('packages/agent-sdk/src/session/types.ts'), 'utf8');
    const packageVerifier = readFileSync(resolve('scripts/verify-packages.mjs'), 'utf8');
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const sessionDocs = readFileSync(resolve('docs/session.md'), 'utf8');
    const publicFields = [
      'temperature',
      'maxOutputTokens',
      'maxContextTokens',
      'providerOptions',
      'thinkingEnabled',
      'thinkingBudget',
      'tokenBudget',
    ];

    for (const field of publicFields) {
      expect(sessionTypes).toContain(`${field}?:`);
      expect(packageVerifier).toContain(`${field}:`);
      expect(publishedVerifier).toContain(`${field}:`);
      expect(readme).toContain(field);
      expect(sessionDocs).toContain(`| \`${field}\``);
    }
  });

  it('type-checks public subpath declarations from the published temporary consumer', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain("from '@blade-ai/ai/model';");
    expect(publishedVerifier).toContain("from '@blade-ai/ai/providers/openai-compatible';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent/kernel';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent/ports';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent/protocol';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/session';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/tools';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/core';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/server';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/local';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/browser';");
    expect(roadmap).toContain('public subpath declarations');
  });

  it('rejects server-only contracts from published browser-safe core declarations', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedCoreDeclarationBoundary');
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent-sdk/dist/core/index.d.ts");
    expect(publishedVerifier).toContain("forbidden: 'createSession'");
    expect(publishedVerifier).toContain("forbidden: 'resumeSession'");
    expect(publishedVerifier).toContain("forbidden: 'forkSession'");
    expect(publishedVerifier).toContain("forbidden: 'getBuiltinTools'");
    expect(publishedVerifier).toContain("forbidden: 'createSdkMcpServer'");
    expect(publishedVerifier).toContain('published core declarations must stay browser-safe');
  });

  it('rejects node-local adapters from published root package declarations', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedRootDeclarationBoundary');
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent-sdk/dist/index.d.ts");
    expect(publishedVerifier).toContain("forbidden: 'getBuiltinTools'");
    expect(publishedVerifier).toContain("forbidden: 'createSdkMcpServer'");
    expect(publishedVerifier).toContain("forbidden: 'FileSystemMemoryStore'");
    expect(publishedVerifier).toContain("forbidden: 'SandboxExecutor'");
    expect(publishedVerifier).toContain(
      'published root declarations must keep Node-local builtin tools behind @blade-ai/agent-sdk/local',
    );
  });

  it('rejects provider-specific helpers from published root package declarations', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedRootDeclarationBoundary');
    expect(publishedVerifier).toContain("node_modules/@blade-ai/agent-sdk/dist/index.d.ts");
    expect(publishedVerifier).toContain("forbidden: 'normalizeDeepSeekModel'");
    expect(publishedVerifier).toContain("forbidden: 'calculateDeepSeekCost'");
    expect(publishedVerifier).toContain("forbidden: 'DeepSeekCostTracker'");
    expect(publishedVerifier).toContain("forbidden: 'DEEPSEEK_DEFAULT_MODEL'");
    expect(publishedVerifier).toContain(
      'published root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
    );
  });

  it('browser-bundles published browser-safe entrypoints from the temporary consumer', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');

    expect(publishedVerifier).toContain("import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';");
    expect(publishedVerifier).toContain('esbuild@^0.28.1');
    expect(publishedVerifier).toContain('verifyPublishedBrowserBundleSmoke');
    expect(publishedVerifier).toContain('consumer-browser-entry.ts');
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/session';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/server';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/local';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/core';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent-sdk/tools';");
    expect(publishedVerifier).toContain('await bundleWithEsbuildRetry({');
    expect(publishedVerifier).toContain("platform: 'browser'");
    expect(publishedVerifier).toContain("conditions: ['browser']");
    expect(publishedVerifier).toContain('assertNoBrowserDisallowedMarkers');
    expect(publishedVerifier).toContain('server-only for createSession');
    expect(publishedVerifier).toContain('server-only for getBuiltinTools');
    expect(readme).toContain('browser bundle smoke');
    expect(checklist).toContain('browser bundle smoke');
  });

  it('browser-bundles the published runtime-independent agent package from the temporary consumer', () => {
    const publishedVerifier = readFileSync(resolve('scripts/verify-published.mjs'), 'utf8');
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const checklist = readFileSync(resolve('docs/production-checklist.md'), 'utf8');
    const roadmap = readFileSync(resolve('docs/roadmap/production-agent-sdk-monorepo.md'), 'utf8');

    expect(publishedVerifier).toContain('verifyPublishedAgentBrowserBundleSmoke');
    expect(publishedVerifier).toContain('consumer-agent-browser-entry.ts');
    expect(publishedVerifier).toContain("from '@blade-ai/agent';");
    expect(publishedVerifier).toContain("from '@blade-ai/agent/kernel';");
    expect(publishedVerifier).toContain('agent browser bundle');
    expect(publishedVerifier).toContain('consumer-agent-browser-bundle.js');
    expect(readme).toContain('@blade-ai/agent` browser bundle smoke');
    expect(checklist).toContain('@blade-ai/agent` browser bundle smoke');
    expect(roadmap).toContain('published runtime-independent agent browser bundle');
  });
});

describe('release workflow', () => {
  it('runs after pushes to main and grants the release permissions', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );

    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.permissions).toMatchObject({
      contents: 'write',
      issues: 'write',
      'pull-requests': 'write',
      'id-token': 'write',
    });
  });

  it('serializes main-branch release jobs without cancelling in-flight publishes', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(workflow.concurrency).toEqual({
      group: 'release-main',
      'cancel-in-progress': false,
    });
    expect(releaseVerifier).toContain('release workflow concurrency');
    expect(releaseVerifier).toContain('release workflow must serialize main-branch publishing jobs');
    expect(releaseVerifier).toContain('release workflow must not cancel an in-flight publish');
  });

  it('requires release checkout to fetch full history for tags and release notes', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const checkoutStep = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@')
    );
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(checkoutStep.with).toMatchObject({ 'fetch-depth': 0 });
    expect(releaseVerifier).toContain('release workflow checkout must fetch full git history');
  });

  it('verifies the package before running semantic-release with trusted publishing', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);
    const setupPnpmStep = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('pnpm/action-setup@')
    );
    const setupNodeStep = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/setup-node@')
    );
    const releaseStep = steps.find((step: { run?: string }) =>
      step.run?.includes('semantic-release')
    );

    expect(commands).toEqual([
      'npm install -g npm@11.5.1 --ignore-scripts',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm run verify',
      expect.stringContaining('PREVIOUS_RELEASE_TAG='),
      'pnpm exec semantic-release',
      expect.stringContaining('pnpm run verify:published -- --version "$published_version"'),
    ]);
    expect(setupPnpmStep.with).toMatchObject({
      version: '11.7.0',
    });
    expect(setupNodeStep.with).toMatchObject({
      'node-version': '22.14',
      'registry-url': 'https://registry.npmjs.org',
    });
    expect(releaseStep.env).toMatchObject({
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(releaseStep.env).not.toHaveProperty('NPM_TOKEN');
    expect(releaseStep.env).not.toHaveProperty('NPM_CONFIG_PROVENANCE');
  });

  it('pins the trusted-publishing npm CLI upgrade to an exact version', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(commands).toContain('npm install -g npm@11.5.1 --ignore-scripts');
    expect(commands).not.toContain('npm install -g npm@^11.5.1');
    expect(releaseVerifier).toContain('release workflow must pin the trusted-publishing npm CLI to npm@11.5.1');
  });

  it('disables lifecycle scripts while upgrading the trusted-publishing npm CLI', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(commands).toContain('npm install -g npm@11.5.1 --ignore-scripts');
    expect(releaseVerifier).toContain('release workflow trusted-publishing npm CLI upgrade must ignore lifecycle scripts');
  });

  it('pins the release workflow Node version to the package engine floor in the verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain("setupNodeStep?.with?.['node-version']");
    expect(releaseVerifier).toContain("'22.14'");
    expect(releaseVerifier).toContain('release workflow Node version must match the package engine floor');
  });

  it('skips post-publish verification when semantic-release does not create a new tag', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const releaseStepIndex = steps.findIndex((step: { run?: string }) =>
      step.run?.includes('semantic-release')
    );
    const captureTagStep = steps.find((step: { name?: string }) =>
      step.name === 'Capture latest release tag'
    );
    const captureTagStepIndex = steps.indexOf(captureTagStep);
    const postPublishStep = steps.find((step: { name?: string }) =>
      step.name === 'Verify published artifacts'
    );

    expect(captureTagStepIndex).toBeLessThan(releaseStepIndex);
    expect(captureTagStep.run).toContain('PREVIOUS_RELEASE_TAG=');
    expect(captureTagStep.run).toContain('$GITHUB_ENV');
    expect(postPublishStep.run).toContain('$PREVIOUS_RELEASE_TAG');
    expect(postPublishStep.run).toContain('No new release tag detected; skipping post-publish verification.');
    expect(postPublishStep.run).toContain('[ "$published_version" = "$PREVIOUS_RELEASE_TAG" ]');
  });

  it('runs post-publish verification against the latest release tag after semantic-release', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const releaseStepIndex = steps.findIndex((step: { run?: string }) =>
      step.run?.includes('semantic-release')
    );
    const postPublishStep = steps.find((step: { name?: string }) =>
      step.name === 'Verify published artifacts'
    );
    const postPublishStepIndex = steps.indexOf(postPublishStep);

    expect(postPublishStepIndex).toBeGreaterThan(releaseStepIndex);
    expect(postPublishStep.run).toContain('git fetch --tags --force');
    expect(postPublishStep.run).toContain("git describe --tags --abbrev=0 --match 'v*'");
    expect(postPublishStep.run).toContain('pnpm run verify:published -- --version "$published_version"');
    expect(postPublishStep.env).toMatchObject({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });
});

describe('ci workflow', () => {
  it('runs the full production verify chain on pushes and pull requests', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
    );
    const steps = workflow.jobs.verify.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);

    expect(workflow.on.push.branches).toEqual([
      'main',
      'master',
      'refactor/**',
      'codex/**',
    ]);
    expect(workflow.on.pull_request).toBeNull();
    expect(commands).toEqual([
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm run verify',
    ]);
  });

  it('requires workflow dependency installs to ignore lifecycle scripts', () => {
    const workflowPaths = [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/deploy-docs.yml',
    ];
    for (const workflowPath of workflowPaths) {
      const workflow = parse(readFileSync(resolve(workflowPath), 'utf8'));
      const jobs = Object.values(workflow.jobs ?? {}) as Array<{ steps?: Array<{ run?: string }> }>;
      const installCommands = jobs
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.run)
        .filter((command): command is string => command?.startsWith('pnpm install') ?? false);

      expect(installCommands.length).toBeGreaterThan(0);
      for (const command of installCommands) {
        expect(command).toContain('--frozen-lockfile');
        expect(command).toContain('--ignore-scripts');
      }
    }

    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');
    expect(releaseVerifier).toContain('verifyWorkflowDependencyInstalls');
    expect(releaseVerifier).toContain('--ignore-scripts');
    expect(releaseVerifier).toContain('workflow dependency install commands must ignore lifecycle scripts');
  });

  it('keeps CI workflow toolchain pins covered by the release verifier', () => {
    const releaseVerifier = readFileSync(resolve('scripts/verify-release-config.mjs'), 'utf8');

    expect(releaseVerifier).toContain("'.github/workflows/ci.yml'");
    expect(releaseVerifier).toContain('verifyCiWorkflow');
    expect(releaseVerifier).toContain('ci workflow must run on Node 22');
    expect(releaseVerifier).toContain('ci workflow must pin pnpm/action-setup to pnpm 11.7.0');
  });
});
