import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'chat/index': 'src/chat/index.ts',
    'deepseek/index': 'src/deepseek/index.ts',
    'retry/index': 'src/retry/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
});
