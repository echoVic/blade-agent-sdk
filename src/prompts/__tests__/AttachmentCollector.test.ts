import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob } from 'tinyglobby';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentCollector } from '../processors/AttachmentCollector.js';

vi.mock('tinyglobby', async (importOriginal) => {
  const original = await importOriginal<typeof import('tinyglobby')>();
  return { ...original, glob: vi.fn(original.glob) };
});
const { glob: realGlob } = await vi.importActual<typeof import('tinyglobby')>('tinyglobby');

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
    vi.mocked(glob).mockReset().mockImplementation(realGlob);
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

  it.skipIf(process.platform === 'win32')(
    'expands an explicitly named symlink base for file attachments',
    async () => {
      const [attachment] = await collector.collect('@linked/**');
      expect(attachment?.type).toBe('file');
      expect(attachment?.content).toContain('linked/visible.ts');
    },
  );

  it('applies the same exclusions to a directory tree', async () => {
    await symlink(join(root, 'src'), join(root, 'src', 'linked'), 'dir');
    const [attachment] = await collector.collect('@src');
    expect(attachment?.type).toBe('directory');
    expect(attachment?.content).toContain('visible.ts');
    expect(attachment?.content).not.toMatch(/hidden|ignored|linked/);
  });
});

describe('attachment ordering', () => {
  it('selects the same first 30 paths regardless of glob traversal order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blade-attachment-order-'));
    try {
      const files = Array.from(
        { length: 35 },
        (_, index) => `file-${String(index).padStart(2, '0')}.ts`,
      );
      await Promise.all(files.map((file) => writeFile(join(root, file), file)));
      const collector = new AttachmentCollector({ cwd: root });
      vi.mocked(glob)
        .mockResolvedValueOnce([...files].reverse())
        .mockResolvedValueOnce([...files]);
      const [reverse] = await collector.collect('@*.ts');
      const [forward] = await collector.collect('@*.ts');
      expect(reverse).toEqual(forward);
      expect(reverse?.content).toContain('--- file-00.ts');
      expect(reverse?.content).toContain('--- file-29.ts');
      expect(reverse?.content).not.toContain('--- file-30.ts');
    } finally {
      vi.mocked(glob).mockReset().mockImplementation(realGlob);
      await rm(root, { recursive: true, force: true });
    }
  });
});
