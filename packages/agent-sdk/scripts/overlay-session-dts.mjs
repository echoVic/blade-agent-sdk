import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const sessionDist = join(process.cwd(), 'dist', 'session');
const source = join(sessionDist, 'public-index.d.ts');
const target = join(sessionDist, 'index.d.ts');

copyFileSync(source, target);
rmSync(source, { force: true });
