import { describe, expect, it } from 'vitest';
import {
  normalizeSearchText,
  scoreToolSearchMatch,
  searchTools,
} from '../tools/index.js';
import type { Tool } from '../tools/index.js';

/** Minimal Tool stub with only the fields used by toolSearch. */
const mkTool = (overrides: Partial<Tool> = {}): Tool =>
  ({
    name: 'test-tool',
    displayName: 'Test Tool',
    description: { short: 'A test tool', long: 'A longer description of the test tool' },
    aliases: ['tt'],
    category: 'testing',
    tags: ['test', 'utility'],
    exposure: { discoveryHint: 'test hint' },
    kind: 'custom',
    isReadOnly: true,
    isConcurrencySafe: true,
    getFunctionDeclaration: () =>
      ({ name: 'test-tool', description: 'test', parameters: { type: 'object', properties: {} } }),
    describe: () => ({ short: 'test', long: 'test' }),
    getMetadata: () =>
      ({
        name: 'test-tool',
        kind: 'custom',
        version: '1.0',
        tags: ['test'],
        description: { short: 'test', long: 'test' },
        schema: { type: 'object', properties: {} },
      }),
    build: () => ({ toolName: 'test-tool', params: {}, getDescription: () => 'test', getAffectedPaths: () => [], execute: async () => ({ success: true, llmContent: '' }) }),
    execute: async () => ({ success: true, llmContent: '' }),
    ...overrides,
  } as Tool);

describe('normalizeSearchText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeSearchText('  HELLO   World  ')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normalizeSearchText('')).toBe('');
  });
});

describe('scoreToolSearchMatch', () => {
  it('returns 0 for no match', () => {
    const tool = mkTool();
    expect(scoreToolSearchMatch(tool, 'xyz')).toBe(0);
  });

  it('returns high score for exact name match', () => {
    const tool = mkTool({ name: 'read-file' });
    expect(scoreToolSearchMatch(tool, 'read-file')).toBeGreaterThan(150);
  });

  it('returns score for partial name match', () => {
    const tool = mkTool({ name: 'read-file' });
    expect(scoreToolSearchMatch(tool, 'read')).toBeGreaterThan(0);
  });

  it('returns score for alias match', () => {
    const tool = mkTool({ aliases: ['rf'] });
    expect(scoreToolSearchMatch(tool, 'rf')).toBeGreaterThan(100);
  });

  it('returns score for description match', () => {
    const tool = mkTool();
    const score = scoreToolSearchMatch(tool, 'longer');
    expect(score).toBeGreaterThan(0);
  });

  it('returns score for tag match', () => {
    const tool = mkTool({ tags: ['filesystem'] });
    expect(scoreToolSearchMatch(tool, 'filesystem')).toBeGreaterThan(0);
  });
});

describe('searchTools', () => {
  it('returns empty array for empty query', () => {
    expect(searchTools([mkTool()], '')).toEqual([]);
  });

  it('returns matching tools sorted by relevance', () => {
    const exactTool = mkTool({ name: 'exact-match' });
    const partialTool = mkTool({ name: 'other-exact' });
    const tools = [partialTool, exactTool];
    const results = searchTools(tools, 'exact');
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('exact-match');
    expect(results[1].name).toBe('other-exact');
  });

  it('filters out non-matching tools', () => {
    const matchTool = mkTool({ name: 'match-me' });
    const noMatchTool = mkTool({ name: 'zzz' });
    const results = searchTools([matchTool, noMatchTool], 'match');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('match-me');
  });

  it('handles empty tool list', () => {
    expect(searchTools([], 'query')).toEqual([]);
  });
});
