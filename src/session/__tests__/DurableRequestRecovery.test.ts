import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../types/common.js';
import {
  parseDurableRuntimeContext,
  parseDurableUserMessageContent,
  serializeDurableRuntimeContext,
} from '../DurableRequestRecovery.js';
import { SessionDurableRecorderError } from '../events/SessionDurableRecorder.js';

describe('DurableRequestRecovery', () => {
  it('round-trips every supported request content variant', () => {
    expect(parseDurableUserMessageContent('continue')).toBe('continue');
    expect(
      parseDurableUserMessageContent([
        {
          type: 'text',
          text: 'inspect',
          providerOptions: {
            anthropic: {
              cacheControl: { type: 'ephemeral' },
            },
          },
        },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,recovery' },
        },
      ]),
    ).toEqual([
      {
        type: 'text',
        text: 'inspect',
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral' },
          },
        },
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,recovery' },
      },
    ]);
  });

  it.each([
    42,
    [null],
    [{ type: 'text' }],
    [{ type: 'text', text: 'invalid', providerOptions: [] }],
    [{ type: 'image_url', image_url: {} }],
    [{ type: 'unknown' }],
  ] satisfies JsonValue[])('rejects invalid request content %#', (input) => {
    expect(() => parseDurableUserMessageContent(input)).toThrow(
      SessionDurableRecorderError,
    );
  });

  it('round-trips a complete runtime context', () => {
    const context = {
      id: 'runtime-context',
      capabilities: {
        filesystem: {
          roots: ['/workspace'],
          cwd: '/workspace',
        },
        browser: {
          pageId: 'page-1',
          tabId: 'tab-1',
        },
        network: {
          allowDomains: ['example.com'],
        },
      },
      environment: {
        REGION: 'test',
      },
      metadata: {
        tenant: 'tenant-1',
      },
    };

    expect(parseDurableRuntimeContext(serializeDurableRuntimeContext(context))).toEqual(context);
  });

  it.each([
    { id: 1 },
    { environment: { REGION: 1 } },
    { metadata: [] },
    { capabilities: [] },
    { capabilities: { filesystem: { roots: [1] } } },
    { capabilities: { browser: { pageId: 1 } } },
    { capabilities: { network: { allowDomains: [1] } } },
  ] as JsonObject[])('rejects invalid runtime context %#', (context) => {
    expect(() => parseDurableRuntimeContext(context)).toThrow(
      SessionDurableRecorderError,
    );
  });

  it('rejects non-JSON runtime context values before persistence', () => {
    expect(() =>
      serializeDurableRuntimeContext({
        metadata: {
          value: BigInt(1) as never,
        },
      }),
    ).toThrow(/not JSON serializable/);
  });
});
