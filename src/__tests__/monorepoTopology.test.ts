import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
  exclude?: string[];
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
}

describe('monorepo topology', () => {
  it('declares packages workspace and keeps root as a private orchestrator', () => {
    const root = readJson('package.json');
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8');

    expect(root.private).toBe(true);
    expect(workspace).toContain('packages:');
    expect(workspace).toContain("'packages/*'");
  });

  it('contains ai, agent, and agent-sdk packages with source entrypoints', () => {
    const expectedPackages = [
      ['packages/ai', '@blade-ai/ai'],
      ['packages/agent', '@blade-ai/agent'],
      ['packages/agent-sdk', '@blade-ai/agent-sdk'],
    ] as const;

    for (const [dir, name] of expectedPackages) {
      expect(existsSync(join(dir, 'package.json')), `${dir}/package.json`).toBe(true);
      expect(existsSync(join(dir, 'src/index.ts')), `${dir}/src/index.ts`).toBe(true);
      expect(readJson(join(dir, 'package.json')).name).toBe(name);
    }
  });

  it('makes agent-sdk depend on ai and agent through workspace protocol', () => {
    const sdk = readJson('packages/agent-sdk/package.json');

    expect(sdk.dependencies).toMatchObject({
      '@blade-ai/agent': 'workspace:*',
      '@blade-ai/ai': 'workspace:*',
    });
  });

  it('keeps package builds isolated from the root package config', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const pkg = readJson(join(dir, 'package.json'));

      expect(existsSync(join(dir, 'tsup.config.ts')), `${dir}/tsup.config.ts`).toBe(true);
      expect(existsSync(join(dir, 'tsconfig.build.json')), `${dir}/tsconfig.build.json`).toBe(true);
      expect(pkg.scripts?.build).toBe('tsup --config tsup.config.ts && tsc -p tsconfig.build.json');
    }
  });

  it('resolves workspace packages from source during type checking', () => {
    const agentTsconfig = readJson('packages/agent/tsconfig.json');
    const sdkTsconfig = readJson('packages/agent-sdk/tsconfig.json');

    expect(agentTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/src/index.ts'],
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
  });

  it('excludes test declarations from package build output', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.exclude).toEqual(
        expect.arrayContaining(['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**']),
      );
    }
  });

  it('declares a package boundary verifier for production architecture gates', () => {
    const root = readJson('package.json');

    expect(root.scripts?.['verify:boundaries']).toBe('node scripts/verify-package-boundaries.mjs');
    expect(existsSync(join('scripts', 'verify-package-boundaries.mjs'))).toBe(true);
  });
});
