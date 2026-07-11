import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'kernel/AgentKernel': 'src/kernel/AgentKernel.ts',
    'budget/TokenBudget': 'src/budget/TokenBudget.ts',
    'epoch/ExecutionEpoch': 'src/epoch/ExecutionEpoch.ts',
    'loop/index': 'src/loop/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    'ports/index': 'src/ports/index.ts',
    'recovery/index': 'src/recovery/index.ts',
    'state/index': 'src/state/index.ts',
    'tracing/index': 'src/tracing/index.ts',
    'utils/index': 'src/utils/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  external: ['@blade-ai/ai'],
});
