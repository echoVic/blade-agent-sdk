import { describe, expect, it } from 'vitest';
import { getEnvironmentContext, getEnvironmentInfo } from '../local/environment.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDirs: string[] = [];

async function afterAll(): Promise<void> {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('package-local environment', () => {
  describe('getEnvironmentInfo', () => {
    it('returns a platform string', () => {
      const info = getEnvironmentInfo();
      expect(typeof info.platform).toBe('string');
      expect(info.platform.length).toBeGreaterThan(0);
    });

    it('returns a Node.js version string', () => {
      const info = getEnvironmentInfo();
      expect(info.nodeVersion).toBe(process.version);
    });

    it('returns a home directory', () => {
      const info = getEnvironmentInfo();
      expect(typeof info.homeDirectory).toBe('string');
      expect(info.homeDirectory.length).toBeGreaterThan(0);
    });

    it('returns a current date in ISO format', () => {
      const info = getEnvironmentInfo();
      expect(info.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('sets projectRoot when .git directory exists', async () => {
      const dir = await createTempDir('blade-pkg-env-root-');
      execSync(`git init --quiet "${dir}"`, { stdio: 'ignore' });

      const info = getEnvironmentInfo(dir);
      expect(info.projectRoot).toBe(dir);
    });

    it('sets projectRoot when package.json exists', async () => {
      const dir = await createTempDir('blade-pkg-env-pkg-');
      execSync(`echo '{"name":"test"}' > "${join(dir, 'package.json')}"`, { stdio: 'ignore' });

      const info = getEnvironmentInfo(dir);
      expect(info.projectRoot).toBe(dir);
    });

    it('preserves workingDirectory in output', async () => {
      const dir = await createTempDir('blade-pkg-env-wd-');
      const info = getEnvironmentInfo(dir);
      expect(info.workingDirectory).toBe(dir);
    });
  });

  describe('getEnvironmentContext', () => {
    it('returns a string containing environment context', () => {
      const context = getEnvironmentContext();
      expect(typeof context).toBe('string');
      expect(context).toContain('Environment Context');
      expect(context).toContain('System Information');
    });

    it('includes platform information', () => {
      const context = getEnvironmentContext();
      expect(context).toContain('Platform');
    });

    it('includes file path guidance when workingDir is provided', async () => {
      const dir = await createTempDir('blade-pkg-env-context-');
      const context = getEnvironmentContext(dir);
      expect(context).toContain('Working Directory');
      expect(context).toContain(dir);
    });
  });
});
