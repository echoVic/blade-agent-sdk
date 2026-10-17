import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAgentCommand } from '../../protocol/index.js';
import { parseDurableUserMessageContent } from '../../session/DurableRequestRecovery.js';
import { parseSessionStreamEvent } from '../../session/streamSchema.js';
import { resolveImagePolicy } from '../ImagePolicy.js';
import { imageRefMetadataShape } from '../imageRefSchema.js';
import { normalizeImageContent } from '../normalizeImages.js';
import { ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';

const shape = z.object(imageRefMetadataShape).strict();
const content = (metadata: Record<string, unknown>) => [
  { type: 'image_url', image_url: { url: 'https://example.test/a.png', ...metadata } },
];

describe('image metadata bounds', () => {
  it('allows unbounded alt internally and bounds mediaType strings', () => {
    expect(shape.safeParse({ alt: 'a'.repeat(1000), mediaType: 'm'.repeat(255) }).success).toBe(
      true,
    );
    expect(shape.safeParse({ alt: 'a'.repeat(1001) }).success).toBe(true);
    expect(shape.safeParse({ mediaType: 'm'.repeat(256) }).success).toBe(false);
    expect(shape.safeParse({ mediaType: '' }).success).toBe(false);
  });
  it('normalizes a long alt and recovers it through durable JSON', async () => {
    const vision = { images: true, toolResultImages: false };
    const normalized = await normalizeImageContent(
      [{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, alt: 'a'.repeat(1001) } }],
      { vision, policy: resolveImagePolicy(undefined, { vision }) },
    );
    expect(normalized).toMatchObject([{ image_url: { alt: 'a'.repeat(1001) } }]);
    expect(parseDurableUserMessageContent(JSON.parse(JSON.stringify(normalized)))).toEqual(
      normalized,
    );
  });

  it.each([1000, 1001])('caps only public input.submit alt at 1000 characters (%i)', (length) => {
    const result = () =>
      parseAgentCommand({
        protocolVersion: 1,
        commandId: 'image-1',
        type: 'input.submit',
        data: { sessionId: 'session-1', input: content({ alt: 'a'.repeat(length) }) },
      });
    if (length === 1000) expect(result).not.toThrow();
    else expect(result).toThrow();
  });

  it('streams tool messages with a long alt', () => {
    const event = {
      type: 'tool_new_messages',
      sessionId: 'session-1',
      id: 'tool-1',
      name: 'Inject',
      messages: [{ role: 'user', content: content({ alt: 'a'.repeat(1001) }) }],
    };
    expect(parseSessionStreamEvent(event)).toEqual(event);
  });

  it.each(['width', 'height', 'byteLength'])('validates %s numeric bounds', (field) => {
    expect(shape.safeParse({ [field]: 0 }).success).toBe(field === 'byteLength');
    expect(shape.safeParse({ [field]: -1 }).success).toBe(false);
    expect(shape.safeParse({ [field]: 1.5 }).success).toBe(false);
    expect(shape.safeParse({ [field]: 1 }).success).toBe(true);
  });
  it.each([
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
