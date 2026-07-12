import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

function findPackageJson(moduleDir: string): string {
  // Walk up from the dist directory to find the nearest package.json.
  // This works regardless of how deeply tsup inlines this module into dist chunks.
  let current = moduleDir;
  for (let i = 0; i < 10; i++) {
    try {
      const candidate = join(current, 'package.json');
      readFileSync(candidate, 'utf-8'); // probe existence
      return candidate;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('@blade-ai/agent-sdk: cannot resolve package.json');
}

const distDir = dirname(fileURLToPath(import.meta.url));
const pkgPath = findPackageJson(distDir);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name: string; version: string };

export function getVersion(): string {
  return pkg.version;
}

export function getPackageName(): string {
  return pkg.name;
}
