import { describe, expect, it } from 'bun:test';
import { SensitiveFileDetector, SensitivityLevel } from '../SensitiveFileDetector.js';

describe('SensitiveFileDetector', () => {
  describe('check - HIGH level files', () => {
    it('should detect SSH private keys', () => {
      const result = SensitiveFileDetector.check('id_rsa');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .pem files', () => {
      const result = SensitiveFileDetector.check('/path/to/cert.pem');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .key files', () => {
      const result = SensitiveFileDetector.check('server.key');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .p12 files', () => {
      const result = SensitiveFileDetector.check('cert.p12');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .pfx files', () => {
      const result = SensitiveFileDetector.check('cert.pfx');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect credentials.json', () => {
      const result = SensitiveFileDetector.check('credentials.json');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect service-account JSON files', () => {
      const result = SensitiveFileDetector.check('service-account-key.json');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect Ed25519 SSH keys', () => {
      const result = SensitiveFileDetector.check('id_ed25519');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });
  });

  describe('check - MEDIUM level files', () => {
    it('should detect .env files', () => {
      const result = SensitiveFileDetector.check('.env');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });

    it('should detect .env.local files', () => {
      const result = SensitiveFileDetector.check('.env.local');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });

    it('should detect .npmrc files', () => {
      const result = SensitiveFileDetector.check('.npmrc');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });

    it('should detect .git-credentials', () => {
      const result = SensitiveFileDetector.check('.git-credentials');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });

    it('should detect secrets files', () => {
      const result = SensitiveFileDetector.check('secrets.yaml');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });
  });

  describe('check - LOW level files', () => {
    it('should detect .sqlite files', () => {
      const result = SensitiveFileDetector.check('data.sqlite');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.LOW);
    });

    it('should detect .db files', () => {
      const result = SensitiveFileDetector.check('app.db');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.LOW);
    });

    it('should detect .sql files', () => {
      const result = SensitiveFileDetector.check('dump.sql');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.LOW);
    });
  });

  describe('check - non-sensitive files', () => {
    it('should not flag index.ts', () => {
      const result = SensitiveFileDetector.check('src/index.ts');
      expect(result.isSensitive).toBe(false);
    });

    it('should not flag README.md', () => {
      const result = SensitiveFileDetector.check('README.md');
      expect(result.isSensitive).toBe(false);
    });

    it('should not flag package.json', () => {
      const result = SensitiveFileDetector.check('package.json');
      expect(result.isSensitive).toBe(false);
    });
  });

  describe('check - sensitive paths', () => {
    it('should detect .ssh directory paths', () => {
      const result = SensitiveFileDetector.check('~/.ssh/config');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .aws directory paths', () => {
      const result = SensitiveFileDetector.check('~/.aws/credentials');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('should detect .kube directory paths', () => {
      const result = SensitiveFileDetector.check('~/.kube/config');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });
  });

  describe('checkMultiple', () => {
    it('should check multiple files at once', () => {
      const results = SensitiveFileDetector.checkMultiple([
        'id_rsa',
        '.env',
        'index.ts',
      ]);
      expect(results.size).toBe(3);
      expect(results.get('id_rsa')!.isSensitive).toBe(true);
      expect(results.get('.env')!.isSensitive).toBe(true);
      expect(results.get('index.ts')!.isSensitive).toBe(false);
    });
  });

  describe('filterSensitive', () => {
    it('should filter sensitive files with default min level', () => {
      const results = SensitiveFileDetector.filterSensitive([
        'id_rsa',
        '.env',
        'data.sqlite',
        'index.ts',
      ]);
      expect(results.length).toBe(3);
    });

    it('should filter by minimum level HIGH', () => {
      const results = SensitiveFileDetector.filterSensitive(
        ['id_rsa', '.env', 'data.sqlite', 'index.ts'],
        SensitivityLevel.HIGH
      );
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('id_rsa');
    });

    it('should filter by minimum level MEDIUM', () => {
      const results = SensitiveFileDetector.filterSensitive(
        ['id_rsa', '.env', 'data.sqlite', 'index.ts'],
        SensitivityLevel.MEDIUM
      );
      expect(results.length).toBe(2);
    });
  });

  describe('getSensitivePatterns', () => {
    it('should return non-empty array', () => {
      const patterns = SensitiveFileDetector.getSensitivePatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  describe('getSensitivePaths', () => {
    it('should return non-empty array', () => {
      const paths = SensitiveFileDetector.getSensitivePaths();
      expect(paths.length).toBeGreaterThan(0);
    });
  });
});
