import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePath, PathSecurity } from '../local/pathSecurity.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('package-local pathSecurity', () => {
  describe('PathSecurity.normalize', () => {
    it('resolves a relative path against the workspace root', async () => {
      const root = await createTempDir('blade-pkg-pathsec-root-');
      const result = PathSecurity.normalize('src/index.ts', root);
      expect(result).toBe(join(root, 'src/index.ts'));
    });

    it('passes through an absolute path within the workspace', async () => {
      const root = await createTempDir('blade-pkg-pathsec-abs-');
      const absolute = join(root, 'src/index.ts');
      expect(PathSecurity.normalize(absolute, root)).toBe(absolute);
    });

    it('throws for a path outside the workspace root', async () => {
      const root = await createTempDir('blade-pkg-pathsec-out-');
      expect(() => PathSecurity.normalize('/etc/passwd', root)).toThrow(
        /outside.*workspace/i,
      );
    });

    it('throws for a relative path that escapes via ..', async () => {
      const root = await createTempDir('blade-pkg-pathsec-escape-');
      expect(() => PathSecurity.normalize('../../etc/passwd', root)).toThrow(
        /outside.*workspace/i,
      );
    });

    it('normalises redundant ./.. patterns within the root', async () => {
      const root = await createTempDir('blade-pkg-pathsec-normalise-');
      const result = PathSecurity.normalize(
        'src/../src/./utils/./index.ts',
        root,
      );
      expect(result).toBe(join(root, 'src/utils/index.ts'));
    });
  });

  describe('normalizePath standalone', () => {
    it('resolves relative path against workspace root', async () => {
      const root = await createTempDir('blade-pkg-pathsec-standalone-');
      const result = normalizePath('src/index.ts', root);
      expect(result).toBe(join(root, 'src/index.ts'));
    });
  });

  describe('PathSecurity.checkRestricted', () => {
    it('throws for .git directories', () => {
      expect(() => PathSecurity.checkRestricted('/repo/.git/HEAD')).toThrow(
        /protected/i,
      );
    });

    it('throws for node_modules', () => {
      expect(() =>
        PathSecurity.checkRestricted('/repo/node_modules/pkg/index.js'),
      ).toThrow(/protected/i);
    });

    it('throws for .env files', () => {
      expect(() => PathSecurity.checkRestricted('/repo/.env')).toThrow(
        /protected/i,
      );
    });

    it('does not throw for normal paths', () => {
      expect(() =>
        PathSecurity.checkRestricted('/repo/src/app.ts'),
      ).not.toThrow();
    });
  });

  describe('PathSecurity.getRelativePath', () => {
    it('returns relative path from root', () => {
      const root = '/workspace';
      const result = PathSecurity.getRelativePath('/workspace/src/file.ts', root);
      expect(result).toBe('src/file.ts');
    });
  });

  describe('PathSecurity.isWithinWorkspace', () => {
    it('returns true for paths within workspace', () => {
      expect(
        PathSecurity.isWithinWorkspace('/workspace/src/file.ts', '/workspace'),
      ).toBe(true);
    });

    it('returns false for paths outside workspace', () => {
      expect(
        PathSecurity.isWithinWorkspace('/etc/passwd', '/workspace'),
      ).toBe(false);
    });
  });

  describe('PathSecurity.isRestricted', () => {
    it('returns true for .git paths', () => {
      expect(PathSecurity.isRestricted('/repo/.git/HEAD')).toBe(true);
    });

    it('returns false for normal paths', () => {
      expect(PathSecurity.isRestricted('/repo/src/app.ts')).toBe(false);
    });
  });
});
