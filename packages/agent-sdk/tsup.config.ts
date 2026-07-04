import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const rootPackageJson = JSON.parse(readFileSync('../../package.json', 'utf-8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const external = [
  ...Object.keys(rootPackageJson.dependencies ?? {}),
  ...Object.keys(rootPackageJson.optionalDependencies ?? {}),
  ...Object.keys(rootPackageJson.peerDependencies ?? {}),
  '@blade-ai/agent',
  '@blade-ai/ai',
];

export default defineConfig({
  entry: {
    index: '../../src/index.ts',
    'browser/index': '../../src/browser/index.ts',
    'browser/server-only-stub': '../../src/browser/server-only-stub.ts',
    'core/index': '../../src/core/index.ts',
    'local/index': '../../src/local/index.ts',
    'server/index': '../../src/server/index.ts',
    'session/index': '../../src/session/index.ts',
    'tools/index': '../../src/tools/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  external,
});
