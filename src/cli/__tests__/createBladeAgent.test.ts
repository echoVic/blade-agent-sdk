import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBladeAgent } from '../createBladeAgent.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'create-blade-agent-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('createBladeAgent', () => {
  it('generates a standalone production-stack project without installing', async () => {
    const cwd = await temporaryDirectory();
    const result = await createBladeAgent({
      cwd,
      directory: 'My Agent',
      packageManager: 'pnpm',
      sdkSpecifier: 'file:/tmp/blade-agent-sdk.tgz',
      skipInstall: true,
    });

    const manifest = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'my-agent',
      private: true,
      type: 'module',
      scripts: {
        start: 'node src/server.mjs',
        smoke: 'node src/server.mjs --smoke',
      },
      dependencies: {
        '@blade-ai/agent-sdk': 'file:/tmp/blade-agent-sdk.tgz',
        esbuild: '0.28.2',
        pg: '8.23.0',
      },
    });
    expect(result).toMatchObject({
      packageManager: 'pnpm',
      preset: 'production',
      installed: false,
      verified: false,
      budgetMs: 300_000,
    });

    const server = await readFile(join(result.directory, 'src/server.mjs'), 'utf8');
    expect(server).toContain("const webRoot = join(root, '../web');");
    expect(server).toContain("const composeFile = join(root, '../compose.yaml');");
    expect(server).not.toContain("join(root, '../web-agent-server')");
    expect(await readFile(join(result.directory, 'web/client.js'), 'utf8')).toContain(
      '@blade-ai/agent-sdk/browser',
    );
    expect(await readFile(join(result.directory, 'README.md'), 'utf8')).toContain('pnpm run smoke');
  });

  it('generates a dependency-minimal local project', async () => {
    const cwd = await temporaryDirectory();
    const result = await createBladeAgent({
      cwd,
      directory: 'local-agent',
      packageManager: 'npm',
      preset: 'local',
      sdkSpecifier: 'file:/tmp/blade-agent-sdk.tgz',
      skipInstall: true,
    });

    const manifest = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      scripts: {
        start: 'node src/index.mjs',
        smoke: 'node src/index.mjs --smoke',
      },
      dependencies: {
        '@blade-ai/agent-sdk': 'file:/tmp/blade-agent-sdk.tgz',
      },
    });
    expect(Object.keys(manifest.dependencies)).toEqual(['@blade-ai/agent-sdk']);
    expect(result).toMatchObject({
      preset: 'local',
      budgetMs: 60_000,
    });
    const entrypoint = await readFile(join(result.directory, 'src/index.mjs'), 'utf8');
    expect(entrypoint).toContain('@blade-ai/agent-sdk/node');
    expect(entrypoint).toContain('const persistSession = false;');
    expect(await readFile(join(result.directory, 'README.md'), 'utf8')).toMatch(
      /no\s+PostgreSQL or Docker/,
    );
  });

  it('generates a browser and in-process server project without PostgreSQL', async () => {
    const cwd = await temporaryDirectory();
    const result = await createBladeAgent({
      cwd,
      directory: 'web-agent',
      packageManager: 'npm',
      preset: 'web',
      sdkSpecifier: 'file:/tmp/blade-agent-sdk.tgz',
      skipInstall: true,
    });

    const manifest = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      scripts: {
        start: 'node src/server.mjs',
        smoke: 'node src/server.mjs --smoke',
      },
      dependencies: {
        '@blade-ai/agent-sdk': 'file:/tmp/blade-agent-sdk.tgz',
        esbuild: '0.28.2',
      },
    });
    expect(manifest.dependencies).not.toHaveProperty('pg');
    expect(result).toMatchObject({
      preset: 'web',
      budgetMs: 120_000,
    });
    const server = await readFile(join(result.directory, 'src/server.mjs'), 'utf8');
    expect(server).toContain("const webRoot = join(root, '../web');");
    expect(server).toContain("const generated = join(root, '../.generated');");
    expect(server).toContain('AgentServer');
    expect(await readFile(join(result.directory, 'web/client.js'), 'utf8')).toContain(
      '@blade-ai/agent-sdk/browser',
    );
  });

  it('refuses to overwrite a non-empty target directory', async () => {
    const cwd = await temporaryDirectory();
    const target = join(cwd, 'existing');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');

    await expect(
      createBladeAgent({
        cwd,
        directory: 'existing',
        skipInstall: true,
      }),
    ).rejects.toThrow(`Target directory is not empty: ${target}`);
    await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('requires installation when verification is requested', async () => {
    await expect(
      createBladeAgent({
        cwd: await temporaryDirectory(),
        skipInstall: true,
        verify: true,
      }),
    ).rejects.toThrow('--verify cannot be combined with --skip-install');
  });

  it('rejects unsupported presets from JavaScript callers', async () => {
    await expect(
      createBladeAgent({
        cwd: await temporaryDirectory(),
        preset: 'edge' as never,
        skipInstall: true,
      }),
    ).rejects.toThrow('Unsupported starter preset: edge');
  });
});
