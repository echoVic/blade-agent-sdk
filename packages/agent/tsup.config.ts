import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'kernel/AgentKernel': 'src/kernel/AgentKernel.ts',
    'protocol/index': 'src/protocol/index.ts',
    'ports/index': 'src/ports/index.ts',
    'state/index': 'src/state/index.ts',
    'tracing/index': 'src/tracing/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  external: ['@blade-ai/ai'],
});
