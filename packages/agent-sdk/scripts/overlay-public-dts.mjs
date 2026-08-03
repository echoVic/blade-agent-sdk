import { copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const overlays = [
  ['public-index.d.ts', 'index.d.ts'],
  ['local/public-index.d.ts', 'local/index.d.ts'],
  ['session/public-index.d.ts', 'session/index.d.ts'],
  ['tools/public-index.d.ts', 'tools/index.d.ts'],
];
const publicDeclarationMaps = [
  'core/index.d.ts.map',
  'index.d.ts.map',
  'local/index.d.ts.map',
  'session/index.d.ts.map',
  'subagents/index.d.ts.map',
  'tools/index.d.ts.map',
  'types/permissions.d.ts.map',
];

for (const [sourcePath, targetPath] of overlays) {
  const source = join(dist, sourcePath);
  const target = join(dist, targetPath);

  copyFileSync(source, target);
  const rewritten = readFileSync(target, 'utf8').replaceAll('public-index.js', 'index.js');
  writeFileSync(target, rewritten);
  rmSync(source, { force: true });
}

// Any other emitted declaration that referenced a public-index module (whose
// artifact is overlaid into index.d.ts and removed above) must be rewritten to
// the overlay target, otherwise the packed declarations would dangle.
function rewriteDeclarationReferences(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      rewriteDeclarationReferences(fullPath);
      continue;
    }
    if (!fullPath.endsWith('.d.ts')) continue;
    const source = readFileSync(fullPath, 'utf8');
    if (source.includes('public-index.js')) {
      writeFileSync(fullPath, source.replaceAll('public-index.js', 'index.js'));
    }
  }
}
rewriteDeclarationReferences(dist);

for (const sourceMapPath of publicDeclarationMaps) {
  rmSync(join(dist, sourceMapPath), { force: true });
}
