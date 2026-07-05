import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);

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
      expect(readme).toContain(pkg.name);
      for (const text of pkg.requiredReadmeText) {
        expect(readme).toContain(text);
      }
      expect(packageVerifier).toContain(`name: '${pkg.name}'`);
      expect(packageVerifier).toContain("'package/README.md'");
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
    expect(readme).toContain('临时 consumer');
    expect(checklist).toContain('临时 consumer');
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
    expect(roadmap).toContain('public subpath declarations');
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
      'npm install -g npm@^11.5.1',
      'pnpm install --frozen-lockfile',
      'pnpm run verify',
      'pnpm exec semantic-release',
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
      'pnpm install --frozen-lockfile',
      'pnpm run verify',
    ]);
  });
});
