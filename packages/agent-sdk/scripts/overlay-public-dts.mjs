import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const overlays = [
  ['session/public-index.d.ts', 'session/index.d.ts'],
  ['tools/public-index.d.ts', 'tools/index.d.ts'],
];

for (const [sourcePath, targetPath] of overlays) {
  const source = join(dist, sourcePath);
  const target = join(dist, targetPath);

  copyFileSync(source, target);
  rmSync(source, { force: true });
}
