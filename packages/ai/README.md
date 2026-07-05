# @blade-ai/ai

Provider-agnostic model runtime contracts for Blade Agent.

Use this package when you want to work directly with the model layer instead of the session-first SDK. It owns `ModelPort`, normalized model requests/responses, stream events, usage metadata, and provider adapters such as OpenAI-compatible / GLM and Vercel AI SDK models.

```ts
import { createOpenAICompatibleModelPort } from '@blade-ai/ai';

const model = createOpenAICompatibleModelPort({
  apiKey: process.env.GLM_API_KEY!,
  baseUrl: process.env.GLM_BASE_URL!,
  model: 'glm-5.2',
});

const response = await model.generate({
  messages: [{ role: 'user', content: 'Say hello' }],
});
```

Most application code should use `@blade-ai/agent-sdk`. Use `@blade-ai/ai` directly for provider adapters, model tests, usage normalization, or custom runtime integration.

Full example: `examples/ai-model-port.ts` in the repository.
