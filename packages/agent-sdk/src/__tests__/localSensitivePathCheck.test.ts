import { describe, expect, it } from 'vitest';
import { isSensitivePath } from '../local/file/sensitivePathCheck.js';

describe('package-local sensitivePathCheck', () => {
  it('flags .env files as sensitive', () => {
    expect(isSensitivePath('/repo/.env')).toBe(true);
    expect(isSensitivePath('/repo/.env.local')).toBe(true);
    expect(isSensitivePath('/project/.env.production')).toBe(true);
  });

  it('flags known credential file names as sensitive', () => {
    expect(isSensitivePath('/home/user/credentials')).toBe(true);
    expect(isSensitivePath('/app/credentials.json')).toBe(true);
    expect(isSensitivePath('/etc/secrets')).toBe(true);
    expect(isSensitivePath('/etc/secrets.yaml')).toBe(true);
    expect(isSensitivePath('/home/user/.npmrc')).toBe(true);
    expect(isSensitivePath('/home/user/id_rsa')).toBe(true);
    expect(isSensitivePath('/home/user/id_ed25519')).toBe(true);
  });

  it('flags cryptographic key extensions as sensitive', () => {
    expect(isSensitivePath('/certs/server.pem')).toBe(true);
    expect(isSensitivePath('/certs/server.key')).toBe(true);
    expect(isSensitivePath('/certs/server.p12')).toBe(true);
    expect(isSensitivePath('/certs/server.keystore')).toBe(true);
  });

  it('does not flag normal source files', () => {
    expect(isSensitivePath('/src/app.ts')).toBe(false);
    expect(isSensitivePath('/src/config.json')).toBe(false);
    expect(isSensitivePath('/docs/readme.md')).toBe(false);
    expect(isSensitivePath('/data/data.csv')).toBe(false);
  });

  it('does not flag files merely containing sensitive-looking substrings', () => {
    expect(isSensitivePath('/src/secretary.ts')).toBe(false);
    expect(isSensitivePath('/src/monkey.json')).toBe(false);
    expect(isSensitivePath('/src/credential_handler.ts')).toBe(false);
  });

  it('is case-insensitive for basename matching', () => {
    expect(isSensitivePath('/repo/.ENV')).toBe(true);
    expect(isSensitivePath('/repo/.ENV.LOCAL')).toBe(true);
    expect(isSensitivePath('/home/CREDENTIALS')).toBe(true);
  });
});
