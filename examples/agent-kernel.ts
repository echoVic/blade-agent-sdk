import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from '@blade-ai/ai';
import { AgentKernel } from '@blade-ai/agent';

function createEchoResponse(request: ModelRequest): ModelResponse {
  const lastUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
  const content = lastUserMessage?.content ?? '';

  return {
    content: `Echo: ${content}`,
    finishReason: 'stop',
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
  };
}

const echoModel: ModelPort = {
  async generate(request) {
    return createEchoResponse(request);
  },

  async *stream(request): AsyncIterable<ModelStreamEvent> {
    const response = createEchoResponse(request);

    yield { type: 'content_delta', delta: response.content };
    yield { type: 'usage', usage: response.usage! };
    yield { type: 'done', response, finishReason: response.finishReason };
  },
};

async function main(): Promise<void> {
  const kernel = new AgentKernel({
    model: echoModel,
    modelCallMode: 'stream',
    maxSteps: 1,
  });

  for await (const event of kernel.runTurn({ input: 'hello kernel' })) {
    if (event.type === 'content') {
      process.stdout.write(event.delta);
    }

    if (event.type === 'usage') {
      console.error('\nusage', event.usage);
    }

    if (event.type === 'result') {
      console.error('\nfinishReason', event.finishReason);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
