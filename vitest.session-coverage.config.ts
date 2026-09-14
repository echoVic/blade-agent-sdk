import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const sessionModules = [
  'src/session/AgentSession.ts',
  'src/session/Session.ts',
  'src/session/SessionDurability.ts',
  'src/session/SessionLifecycle.ts',
  'src/session/SessionRequestCoordinator.ts',
  'src/session/SessionState.ts',
  'src/session/SessionStreamRunner.ts',
  'src/session/StreamBroadcaster.ts',
];

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: sessionModules,
      reporter: ['text', 'json-summary'],
      reportsDirectory: resolve(import.meta.dirname, 'coverage/session'),
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 60,
        statements: 60,
      },
    },
  },
});
