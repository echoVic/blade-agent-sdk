import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentCollector } from '../processors/AttachmentCollector.js';

describe('AttachmentCollector glob compatibility', () => {
  let root: string;
  let collector: AttachmentCollector;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'blade-attachments-'));
    collector = new AttachmentCollector({ cwd: root });
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'src', 'node_modules'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'ignored.ts'), 'ROOT_IGNORED');
    await writeFile(join(root, 'src', 'visible.ts'), 'VISIBLE');
    await writeFile(join(root, 'src', '.hidden.ts'), 'HIDDEN');
    await writeFile(join(root, 'src', 'node_modules', 'ignored.ts'), 'IGNORED');
    await symlink(join(root, 'src'), join(root, 'linked'), 'dir');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('excludes dotfiles, ignored directories and symlink traversal from glob attachments', async () => {
    const [attachment] = await collector.collect('@**/*.ts');
    expect(attachment?.type).toBe('file');
    expect(attachment?.content).toContain('src/visible.ts');
    expect(attachment?.content).not.toMatch(/HIDDEN|ROOT_IGNORED|linked/);
  });

  it('uses case-sensitive glob matching', async () => {
    expect(await collector.collect('@src/*.TS')).toMatchObject([{ type: 'error' }]);
  });

  it('does not expand a directory named by a glob pattern', async () => {
    expect(await collector.collect('@s*')).toMatchObject([{ type: 'error' }]);
  });

  it('applies the same exclusions to a directory tree', async () => {
    await symlink(join(root, 'src'), join(root, 'src', 'linked'), 'dir');
    const [attachment] = await collector.collect('@src');
    expect(attachment?.type).toBe('directory');
    expect(attachment?.content).toContain('visible.ts');
    expect(attachment?.content).not.toMatch(/hidden|ignored|linked/);
  });
});
