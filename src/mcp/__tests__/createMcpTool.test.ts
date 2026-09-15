import type { JSONSchema7 } from 'json-schema';
import { describe, expect, it, vi } from 'vitest';
import { createMcpTool } from '../createMcpTool.js';

const mockClient = {
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
};

function buildTool(schema: JSONSchema7) {
  return createMcpTool(mockClient as never, 'test-server', {
    name: 'schema_tool',
    description: 'Schema test tool',
    inputSchema: schema,
  });
}

describe('createMcpTool', () => {
  it('classifies remote MCP tools conservatively', () => {
    const tool = buildTool({ type: 'object' });

    expect(tool.name).toBe('mcp__test-server__schema_tool');
    expect(tool.staticBehavior.sideEffect).toBe('non_idempotent');
    expect(tool.tags).toContain('mcp-server:test-server');
  });

  it('preserves the MCP JSON Schema as the model-facing declaration', () => {
    const inputSchema: JSONSchema7 = {
      $id: 'mcp://schemas/search',
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
      },
      required: ['query'],
      additionalProperties: false,
    };
    const tool = buildTool(inputSchema);

    expect(tool.declaration.parameters).toEqual(inputSchema);
  });

  it('treats a missing MCP input schema as an empty object without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tool = createMcpTool(mockClient as never, 'test-server', {
        name: 'schema_less_tool',
        description: 'No input schema',
        inputSchema: undefined,
      } as never);

      expect(() => tool.prepare({})).not.toThrow();
      expect(tool.declaration.parameters).toMatchObject({
        type: 'object',
        properties: {},
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the remote protocol name separate from the exposed namespace', async () => {
    const tool = buildTool({ type: 'object' });

    const iterator = tool.execute({}, {});
    await iterator.next();

    expect(mockClient.callTool).toHaveBeenCalledWith('schema_tool', {});
  });

  it('should support enum values for strings and numbers', () => {
    const tool = buildTool({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        code: { type: 'number', enum: [1, 2, 3] },
      },
      required: ['status', 'code'],
    });

    expect(() => tool.prepare({ status: 'open', code: 2 })).not.toThrow();
    expect(() => tool.prepare({ status: 'other', code: 2 })).toThrow();
    expect(() => tool.prepare({ status: 'open', code: 4 })).toThrow();
  });

  it('should support nullable fields via union types', () => {
    const tool = buildTool({
      type: 'object',
      properties: {
        note: { type: ['string', 'null'] },
      },
    });

    expect(() => tool.prepare({ note: 'hello' })).not.toThrow();
    expect(() => tool.prepare({ note: null })).not.toThrow();
    expect(() => tool.prepare({ note: 123 })).toThrow();
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

    expect(() => tool.prepare({ metadata: { a: 1, b: 2 } })).not.toThrow();
    expect(() => tool.prepare({ metadata: { a: 'bad' } })).toThrow();
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

    expect(() => tool.prepare({ query: 'hello', options: { limit: 3 } })).not.toThrow();
    expect(() => tool.prepare({ query: 'hello', options: { limit: 0 } })).toThrow();
  });

  it('should fall back to record schema when encountering unsupported refs', () => {
    const warn = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const tool = buildTool({
        $ref: '#/definitions/missing',
      });

      expect(() => tool.prepare({ anything: 'goes' })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
