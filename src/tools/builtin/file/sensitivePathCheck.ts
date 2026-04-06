import { basename, extname } from 'path';

/**
 * Check whether a file path points to a sensitive file (credentials, keys, secrets).
 * Uses basename and extension matching to avoid false positives on normal files
 * like secretary.txt or monkey.ts.
 */
export function isSensitivePath(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  const ext = extname(filePath).toLowerCase();

  // Exact basename matches: .env, .env.local, .env.production, etc.
  if (name === '.env' || name.startsWith('.env.')) return true;

  // Exact basename matches for known credential files
  const sensitiveNames = ['credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml',
    'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml',
    '.npmrc', '.pypirc', '.netrc', '.pgpass', 'id_rsa', 'id_ed25519', 'id_ecdsa'];
  if (sensitiveNames.includes(name)) return true;

  // Extension-only matches for cryptographic key material
  const sensitiveExtensions = ['.pem', '.key', '.p12', '.pfx', '.keystore'];
  if (sensitiveExtensions.includes(ext)) return true;

  return false;
}
