import { createOpenAICompatibleModelPort } from '@blade-ai/ai';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const model = createOpenAICompatibleModelPort({
    apiKey: requireEnv('GLM_API_KEY'),
    baseUrl: requireEnv('GLM_BASE_URL'),
    model: process.env.BLADE_MODEL ?? 'glm-5.2',
  });

  const response = await model.generate({
    messages: [
      {
        role: 'user',
        content: '用一句话说明 @blade-ai/ai 这一层负责什么。',
      },
    ],
    temperature: 0.2,
    maxOutputTokens: 256,
  });

  console.log(response.content);

  if (response.usage) {
    console.error('usage', response.usage);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
