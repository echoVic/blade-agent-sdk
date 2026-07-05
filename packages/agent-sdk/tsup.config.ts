import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const external = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
  '@blade-ai/agent',
  '@blade-ai/ai',
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
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  external,
});
