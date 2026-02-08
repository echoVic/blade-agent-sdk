import { describe, expect, it } from 'bun:test';
import * as path from 'path';
import { PathSecurity, PathSecurityError } from '../pathSecurity.js';

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
      expect(() => {
        PathSecurity.normalize('/etc/passwd', workspaceRoot);
      }).toThrow(PathSecurityError);
    });

    it('should handle paths with . and ..', () => {
      const result = PathSecurity.normalize('./src/../src/index.ts', workspaceRoot);
      expect(result).toBe(path.join(workspaceRoot, 'src/index.ts'));
    });

    it('should throw when .. escapes workspace', () => {
      expect(() => {
        PathSecurity.normalize('../../../etc/passwd', workspaceRoot);
      }).toThrow(PathSecurityError);
    });
  });

  describe('checkRestricted', () => {
    it('should throw for .git paths', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/.git/config');
      }).toThrow(PathSecurityError);
    });

    it('should throw for node_modules paths', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/node_modules/lodash/index.js');
      }).toThrow(PathSecurityError);
    });

    it('should throw for .env files', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/.env');
      }).toThrow(PathSecurityError);
    });

    it('should throw for .env.local files', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/.env.local');
      }).toThrow(PathSecurityError);
    });

    it('should throw for .claude paths', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/.claude/settings.json');
      }).toThrow(PathSecurityError);
    });

    it('should not throw for normal paths', () => {
      expect(() => {
        PathSecurity.checkRestricted('/workspace/project/src/index.ts');
      }).not.toThrow();
    });
  });

  describe('checkTraversal', () => {
    it('should throw for paths with ..', () => {
      expect(() => {
        PathSecurity.checkTraversal('../etc/passwd');
      }).toThrow(PathSecurityError);
    });

    it('should throw for paths with .. in middle', () => {
      expect(() => {
        PathSecurity.checkTraversal('src/../../../etc/passwd');
      }).toThrow(PathSecurityError);
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

  describe('PathSecurityError', () => {
    it('should have correct name', () => {
      const error = new PathSecurityError('Test error', 'TEST_CODE');
      expect(error.name).toBe('PathSecurityError');
    });

    it('should have correct code', () => {
      const error = new PathSecurityError('Test error', 'TEST_CODE');
      expect(error.code).toBe('TEST_CODE');
    });

    it('should have correct message', () => {
      const error = new PathSecurityError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
    });
  });
});
