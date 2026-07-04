import { createSession } from '@blade-ai/agent-sdk';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const session = await createSession({
    provider: {
      type: 'openai-compatible',
      apiKey: requireEnv('GLM_API_KEY'),
      baseUrl: requireEnv('GLM_BASE_URL'),
    },
    model: process.env.BLADE_MODEL ?? 'glm-5.2',
    temperature: 0.2,
    maxOutputTokens: 1024,
    allowedTools: [],
  });

  try {
    await session.send('用三句话总结 Blade Agent SDK 的 session-first 设计。');

    for await (const event of session.stream()) {
      if (event.type === 'content') {
        process.stdout.write(event.delta);
      }

      if (event.type === 'usage') {
        console.error('\nusage', event.usage);
      }
    }
  } finally {
    session.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
