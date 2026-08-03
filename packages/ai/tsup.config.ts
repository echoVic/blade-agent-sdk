import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'chat/index': 'src/chat/index.ts',
    'deepseek/index': 'src/deepseek/index.ts',
    'model/index': 'src/model/index.ts',
    'providers/openai-compatible/index': 'src/providers/openai-compatible/index.ts',
    'providers/vercel/index': 'src/providers/vercel/index.ts',
    'providers/index': 'src/providers/index.ts',
    'retry/index': 'src/retry/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
});
