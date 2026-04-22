import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { PathSecurity } from '../pathSecurity.js';

function expectPathSecurityError(fn: () => void): void {
  try {
    fn();
    expect.fail('Expected an error to be thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('PathSecurityError');
  }
}

describe('PathSecurity', () => {
  const workspaceRoot = '/workspace/project';

  describe('normalize', () => {
    it('should normalize relative paths', () => {
      const result = PathSecurity.normalize('src/index.ts', workspaceRoot);
      expect(result).toBe(path.join(workspaceRoot, 'src/index.ts'));
    });

    it('should normalize absolute paths within workspace', () => {
      const absolutePath = path.join(workspaceRoot, 'src/index.ts');
      const result = PathSecurity.normalize(absolutePath, workspaceRoot);
      expect(result).toBe(absolutePath);
    });

    it('should throw for paths outside workspace', () => {
      expectPathSecurityError(() => {
        PathSecurity.normalize('/etc/passwd', workspaceRoot);
      });
    });

    it('should handle paths with . and ..', () => {
      const result = PathSecurity.normalize('./src/../src/index.ts', workspaceRoot);
      expect(result).toBe(path.join(workspaceRoot, 'src/index.ts'));
    });

    it('should throw when .. escapes workspace', () => {
      expectPathSecurityError(() => {
        PathSecurity.normalize('../../../etc/passwd', workspaceRoot);
      });
    });
  });

  describe('checkRestricted', () => {
    it('should throw for .git paths', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkRestricted('/workspace/project/.git/config');
      });
    });

    it('should throw for node_modules paths', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkRestricted('/workspace/project/node_modules/lodash/index.js');
      });
    });

    it('should throw for .env files', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkRestricted('/workspace/project/.env');
      });
    });

    it('should throw for .env.local files', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkRestricted('/workspace/project/.env.local');
      });
    });

    it('should throw for .claude paths', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkRestricted('/workspace/project/.claude/settings.json');
      });
    });

    it('should not throw for normal paths', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/src/index.ts');
      }).not.toThrow();
    });
  });

  describe('checkTraversal', () => {
    it('should throw for paths with ..', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkTraversal('../etc/passwd');
      });
    });

    it('should throw for paths with .. in middle', () => {
      expectPathSecurityError(() => {
        PathSecurity.checkTraversal('src/../../../etc/passwd');
      });
    });

    it('should not throw for paths without ..', () => {
      expect(() => {
        PathSecurity.checkTraversal('src/index.ts');
      }).not.toThrow();
    });

    it('should not throw for paths with . only', () => {
      expect(() => {
        PathSecurity.checkTraversal('./src/index.ts');
      }).not.toThrow();
    });
  });

  describe('isWithinWorkspace', () => {
    it('should return true for paths within workspace', () => {
      const absolutePath = path.join(workspaceRoot, 'src/index.ts');
      expect(PathSecurity.isWithinWorkspace(absolutePath, workspaceRoot)).toBe(true);
    });

    it('should return false for paths outside workspace', () => {
      expect(PathSecurity.isWithinWorkspace('/etc/passwd', workspaceRoot)).toBe(false);
    });

    it('should return true for workspace root itself', () => {
      expect(PathSecurity.isWithinWorkspace(workspaceRoot, workspaceRoot)).toBe(true);
    });
  });

  describe('isRestricted', () => {
    it('should return true for .git paths', () => {
      expect(PathSecurity.isRestricted('/workspace/.git/config')).toBe(true);
    });

    it('should return true for node_modules paths', () => {
      expect(PathSecurity.isRestricted('/workspace/node_modules/lodash')).toBe(true);
    });

    it('should return false for normal paths', () => {
      expect(PathSecurity.isRestricted('/workspace/src/index.ts')).toBe(false);
    });
  });

  describe('getRelativePath', () => {
    it('should return relative path', () => {
      const absolutePath = path.join(workspaceRoot, 'src/index.ts');
      const result = PathSecurity.getRelativePath(absolutePath, workspaceRoot);
      expect(result).toBe('src/index.ts');
    });

    it('should handle nested paths', () => {
      const absolutePath = path.join(workspaceRoot, 'src/utils/helper.ts');
      const result = PathSecurity.getRelativePath(absolutePath, workspaceRoot);
      expect(result).toBe(path.join('src', 'utils', 'helper.ts'));
    });
  });

  describe('PathSecurityError behavior', () => {
    it('should have correct name on thrown errors', () => {
      try {
        PathSecurity.normalize('/etc/passwd', workspaceRoot);
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        expect((error as Error).name).toBe('PathSecurityError');
      }
    });

    it('should have correct message on thrown errors', () => {
      try {
        PathSecurity.checkRestricted('/workspace/project/.git/config');
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        expect((error as Error).message).toContain('protected directory');
      }
    });

    it('should have a code property on thrown errors', () => {
      try {
        PathSecurity.normalize('/etc/passwd', workspaceRoot);
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        expect((error as { code: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
      }
    });
  });
});
