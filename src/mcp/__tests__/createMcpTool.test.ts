import { describe, expect, it, mock } from 'bun:test';
import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';
import { createMcpTool } from '../createMcpTool.js';

const mockClient = {
  callTool: mock(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
};

function buildTool(schema: JSONSchema7) {
  return createMcpTool(
    mockClient as never,
    'test-server',
    {
      name: 'schema_tool',
      description: 'Schema test tool',
      inputSchema: schema,
    },
  );
}

describe('createMcpTool', () => {
  it('should support enum values for strings and numbers', () => {
    const tool = buildTool({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        code: { type: 'number', enum: [1, 2, 3] },
      },
      required: ['status', 'code'],
    });

    expect(() => tool.build({ status: 'open', code: 2 })).not.toThrow();
    expect(() => tool.build({ status: 'other', code: 2 })).toThrow();
    expect(() => tool.build({ status: 'open', code: 4 })).toThrow();
  });

  it('should support nullable fields via union types', () => {
    const tool = buildTool({
      type: 'object',
      properties: {
        note: { type: ['string', 'null'] },
      },
    });

    expect(() => tool.build({ note: 'hello' })).not.toThrow();
    expect(() => tool.build({ note: null })).not.toThrow();
    expect(() => tool.build({ note: 123 })).toThrow();
  });

  it('should support object schemas with additionalProperties', () => {
    const tool = buildTool({
      type: 'object',
      properties: {
        metadata: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
      },
    });

    expect(() => tool.build({ metadata: { a: 1, b: 2 } })).not.toThrow();
    expect(() => tool.build({ metadata: { a: 'bad' } })).toThrow();
  });

  it('should resolve local $ref definitions', () => {
    const tool = buildTool({
      type: 'object',
      definitions: {
        filters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1 },
          },
          required: ['limit'],
        },
      },
      properties: {
        query: { type: 'string' },
        options: { $ref: '#/definitions/filters' },
      },
      required: ['query', 'options'],
    });

    expect(() => tool.build({ query: 'hello', options: { limit: 3 } })).not.toThrow();
    expect(() => tool.build({ query: 'hello', options: { limit: 0 } })).toThrow();
  });

  it('should fall back to record schema when encountering unsupported refs', () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const tool = buildTool({
        $ref: '#/definitions/missing',
      });

      expect(() => tool.build({ anything: 'goes' })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
