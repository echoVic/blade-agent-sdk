#!/usr/bin/env node
import { loadLiveGlmConfig } from './live-glm-config.mjs';

const config = loadLiveGlmConfig();

if ('skipReason' in config) {
  console.warn(config.skipReason);
  process.exit(0);
}

const { createOpenAICompatibleModelPort } = await import(
  '../packages/ai/dist/providers/openai-compatible/index.js'
);

const port = createOpenAICompatibleModelPort({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  model: config.model,
  name: 'glm',
});

const nonStreaming = await port.generate({
  messages: [
    { role: 'system', content: 'You are a concise test assistant.' },
    { role: 'user', content: 'Reply with exactly: blade-live-ok' },
  ],
  temperature: 0,
  maxOutputTokens: 128,
});

if (!nonStreaming.content.trim()) {
  throw new Error('GLM live non-streaming response was empty');
}

if (nonStreaming.usage && nonStreaming.usage.totalTokens <= 0) {
  throw new Error('GLM live non-streaming usage totalTokens must be positive when usage is returned');
}

let streamedText = '';
let streamedUsage;
for await (const event of port.stream({
  messages: [
    { role: 'system', content: 'You are a concise test assistant.' },
    { role: 'user', content: 'Reply with exactly: stream-ok' },
  ],
  temperature: 0,
  maxOutputTokens: 128,
})) {
  if (event.type === 'content_delta') streamedText += event.delta;
  if (event.type === 'usage') streamedUsage = event.usage;
  if (event.type === 'error') throw event.error;
}

if (!streamedText.trim()) {
  throw new Error('GLM live streaming response was empty');
}

if (streamedUsage && streamedUsage.totalTokens <= 0) {
  throw new Error('GLM live streaming usage totalTokens must be positive when usage is returned');
}

console.log(`GLM live test passed with model ${config.model}`);
