import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAgentCommand } from '../../protocol/index.js';
import { parseDurableUserMessageContent } from '../../session/DurableRequestRecovery.js';
import { parseSessionStreamEvent } from '../../session/streamSchema.js';
import { imageRefMetadataShape } from '../imageRefSchema.js';

const shape = z.object(imageRefMetadataShape).strict();
const content = (metadata: Record<string, unknown>) => [
  { type: 'image_url', image_url: { url: 'https://example.test/a.png', ...metadata } },
];

describe('image metadata bounds', () => {
  it('bounds alt and mediaType strings', () => {
    expect(shape.safeParse({ alt: 'a'.repeat(1000), mediaType: 'm'.repeat(255) }).success).toBe(
      true,
    );
    expect(shape.safeParse({ alt: 'a'.repeat(1001) }).success).toBe(false);
    expect(shape.safeParse({ mediaType: 'm'.repeat(256) }).success).toBe(false);
    expect(shape.safeParse({ mediaType: '' }).success).toBe(false);
  });
  it.each(['width', 'height', 'byteLength'])('validates %s numeric bounds', (field) => {
    expect(shape.safeParse({ [field]: 0 }).success).toBe(field === 'byteLength');
    expect(shape.safeParse({ [field]: -1 }).success).toBe(false);
    expect(shape.safeParse({ [field]: 1.5 }).success).toBe(false);
    expect(shape.safeParse({ [field]: 1 }).success).toBe(true);
  });
  it.each([
    { alt: 'a'.repeat(1001) },
    { extra: true },
  ])('rejects invalid metadata across protocol, stream and durable schemas', (metadata) => {
    expect(() =>
      parseAgentCommand({
        protocolVersion: 1,
        commandId: 'image-1',
        type: 'input.submit',
        data: { sessionId: 'session-1', input: content(metadata) },
      }),
    ).toThrow();
    expect(() =>
      parseSessionStreamEvent({
        type: 'tool_new_messages',
        sessionId: 'session-1',
        id: 'tool-1',
        name: 'Inject',
        messages: [{ role: 'user', content: content(metadata) }],
      }),
    ).toThrow();
    expect(() => parseDurableUserMessageContent(content(metadata) as never)).toThrow();
  });
});
