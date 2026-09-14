import { describe, expect, it } from 'vitest';
import { createAgent } from '../index.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const runLive = process.env.AGENT_LIVE_TESTS === '1' && apiKey.length > 0;
const describeLive = runLive ? describe : describe.skip;

describeLive('createAgent live integration', () => {
  it.each([1, 2, 3])(
    'replays one DeepSeek data Skill response through every view (run %i)',
    async () => {
      const agent = await createAgent({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        temperature: 0,
        maxOutputTokens: 512,
        maxTurns: 4,
        systemPrompt:
          'When the user requests a listed Skill, call the Skill tool with its exact name before answering.',
        advanced: {
          permission: 'bypass-permissions',
          persistSession: false,
          skills: [
            {
              name: 'phase-two-proof',
              description: 'Use when asked to produce the Phase 2 integration proof token',
              content: 'Reply with exactly: BLADE_PHASE_TWO_SKILL_OK',
            },
          ],
        },
      });

      try {
        const response = await agent.send(
          'Use the phase-two-proof Skill, then follow its instructions.',
        );
        const observedContent: string[] = [];
        const observedToolNames: string[] = [];
        response.on('content', (event) => {
          observedContent.push(event.delta);
        });
        response.on('tool_use', (event) => {
          observedToolNames.push(event.name);
        });

        const text = await response.text();

        const streamedText: string[] = [];
        for await (const chunk of response.textStream()) {
          streamedText.push(chunk);
        }

        const events = [];
        for await (const event of response.stream()) {
          events.push(event);
        }

        expect(text.trim()).toBe('BLADE_PHASE_TWO_SKILL_OK');
        expect(streamedText.join('')).toBe(text);
        expect(observedContent.join('')).toBe(text);
        expect(observedToolNames).toEqual(['Skill']);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool_use', name: 'Skill' }),
            expect.objectContaining({ type: 'tool_result', name: 'Skill', isError: false }),
            expect.objectContaining({ type: 'result', subtype: 'success' }),
          ]),
        );
      } finally {
        await agent.close();
      }
    },
    90_000,
  );
});
