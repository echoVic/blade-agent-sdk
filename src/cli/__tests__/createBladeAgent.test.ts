import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
      installed: false,
      verified: false,
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
});
