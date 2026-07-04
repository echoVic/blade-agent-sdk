#!/usr/bin/env node
import { loadLiveGlmConfig } from './live-glm-config.mjs';

const config = loadLiveGlmConfig();

if ('skipReason' in config) {
  console.warn(config.skipReason);
  process.exit(0);
}

const { createSession } = await import('../packages/agent-sdk/dist/index.js');

const session = await createSession({
  provider: {
    type: 'openai-compatible',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  },
  model: config.model,
  temperature: 0,
  maxOutputTokens: 128,
  maxTurns: 1,
  persistSession: false,
  allowedTools: [],
});

try {
  await session.send('Reply with a short sentence containing: blade-session-ok');

  let content = '';
  let sawResult = false;
  let sawUsage = false;
  let sawToolUse = false;

  for await (const event of session.stream()) {
    if (event.type === 'content') content += event.delta;
    if (event.type === 'usage') sawUsage = true;
    if (event.type === 'tool_use') sawToolUse = true;
    if (event.type === 'result' && event.subtype === 'success') sawResult = true;
    if (event.type === 'error') {
      throw new Error(`Session GLM live stream failed: ${event.code ?? 'UNKNOWN'} ${event.message}`);
    }
  }

  if (!content.trim()) {
    throw new Error('Session GLM live stream content was empty');
  }
  if (!sawResult) {
    throw new Error('Session GLM live stream did not emit a success result');
  }
  if (sawToolUse) {
    throw new Error('Session GLM live stream used a tool even though allowedTools: [] was set');
  }

  console.log(`Session GLM live test passed with model ${config.model}`);
  if (!sawUsage) {
    console.warn('Session GLM live stream did not include usage; provider may omit stream usage.');
  }
} finally {
  await session.close();
}
