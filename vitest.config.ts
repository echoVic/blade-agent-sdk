import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@blade-ai/agent-sdk/server': resolve(__dirname, 'packages/agent-sdk/src/server/index.ts'),
      '@blade-ai/agent-sdk/local': resolve(__dirname, 'packages/agent-sdk/src/local/index.ts'),
      '@blade-ai/agent-sdk/tools': resolve(__dirname, 'packages/agent-sdk/src/tools/index.ts'),
      '@blade-ai/agent-sdk/session/internal': resolve(__dirname, 'packages/agent-sdk/src/session/internal.ts'),
      '@blade-ai/agent-sdk': resolve(__dirname, 'packages/agent-sdk/src/index.ts'),
      '@blade-ai/ai/chat': resolve(__dirname, 'packages/ai/src/chat/index.ts'),
      '@blade-ai/ai/deepseek': resolve(__dirname, 'packages/ai/src/deepseek/index.ts'),
      '@blade-ai/ai/model': resolve(__dirname, 'packages/ai/src/model/index.ts'),
      '@blade-ai/ai/providers/openai-compatible': resolve(__dirname, 'packages/ai/src/providers/openai-compatible/index.ts'),
      '@blade-ai/ai/providers/vercel': resolve(__dirname, 'packages/ai/src/providers/vercel/index.ts'),
      '@blade-ai/ai/retry': resolve(__dirname, 'packages/ai/src/retry/index.ts'),
      '@blade-ai/ai': resolve(__dirname, 'packages/ai/src/index.ts'),
    },
  },
});
