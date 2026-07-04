import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const overlays = [
  ['public-index.d.ts', 'index.d.ts'],
  ['local/public-index.d.ts', 'local/index.d.ts'],
  ['session/public-index.d.ts', 'session/index.d.ts'],
  ['tools/public-index.d.ts', 'tools/index.d.ts'],
];

for (const [sourcePath, targetPath] of overlays) {
  const source = join(dist, sourcePath);
  const target = join(dist, targetPath);

  copyFileSync(source, target);
  const rewritten = readFileSync(target, 'utf8').replaceAll('public-index.js', 'index.js');
  writeFileSync(target, rewritten);
  rmSync(source, { force: true });
}
