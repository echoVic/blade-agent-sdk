import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Mirror the original Bun.build() behaviour: keep every declared package
// external so their __dirname-based path resolution stays intact at runtime.
// Without this, esbuild inlines CJS packages (e.g. @vscode/ripgrep) and
// breaks any paths that were relative to the package's own node_modules dir.
const externals: string[] = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'browser/index': 'src/browser/index.ts',
    'browser/server-only-stub': 'src/browser/server-only-stub.ts',
    'core/index': 'src/core/index.ts',
    'local/index': 'src/local/index.ts',
    'server/index': 'src/server/index.ts',
    'session/index': 'src/session/index.ts',
    'tools/index': 'src/tools/index.ts',
  },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  minify: true,
  clean: true,
  dts: false,
  external: externals,
});
