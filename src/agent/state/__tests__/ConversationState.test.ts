import { describe, expect, it } from 'vitest';
import type { Message } from '../../../services/ChatServiceInterface.js';
import type { JsonObject } from '../../../types/common.js';
import { ConversationState } from '../ConversationState.js';

const sys = (content: string, meta?: JsonObject): Message => ({
  role: 'system',
  content,
  ...(meta ? { metadata: meta } : {}),
});
const user = (content: string): Message => ({ role: 'user', content });
const asst = (content: string): Message => ({ role: 'assistant', content });

describe('ConversationState', () => {
  // ===== 构造 + slot[0] 不变量 =====

  describe('constructor invariants', () => {
    it('places root system prompt at slot[0] when provided', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      const arr = cs.toArray();
      expect(arr[0]).toEqual(sys('root'));
      expect(arr[1]).toEqual(user('hi'));
      expect(cs.hasRootSystemPrompt).toBe(true);
      expect(cs.length).toBe(2);
    });

    it('works without root system prompt', () => {
      const cs = new ConversationState(null, [], user('hi'));
      expect(cs.hasRootSystemPrompt).toBe(false);
      expect(cs.length).toBe(1);
      expect(cs.toArray()[0]).toEqual(user('hi'));
    });

    it('preserves contextMessages between root and user message', () => {
      const ctx: Message[] = [asst('prev'), user('old')];
      const cs = new ConversationState(sys('root'), ctx, user('new'));
      const arr = cs.toArray();
      expect(arr).toEqual([sys('root'), asst('prev'), user('old'), user('new')]);
    });
  });

  // ===== toArray 浅拷贝 =====

  describe('toArray', () => {
    it('returns a shallow copy — pushing to result does not affect internal state', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      const copy = cs.toArray() as Message[];
      copy.push(asst('injected'));
      expect(cs.length).toBe(2); // not 3
    });

    it('successive calls return structurally equal but referentially distinct arrays', () => {
      const cs = new ConversationState(null, [], user('hi'));
      const a = cs.toArray();
      const b = cs.toArray();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  // ===== getContextMessages — 剥离 root slot =====

  describe('getContextMessages', () => {
    it('excludes root system prompt when present', () => {
      const cs = new ConversationState(sys('root'), [asst('ctx')], user('hi'));
      const ctx = cs.getContextMessages();
      expect(ctx.every((m) => !(m.role === 'system' && m.content === 'root'))).toBe(true);
      expect(ctx).toEqual([asst('ctx'), user('hi')]);
    });

    it('returns all messages when no root prompt', () => {
      const cs = new ConversationState(null, [asst('ctx')], user('hi'));
      expect(cs.getContextMessages()).toEqual([asst('ctx'), user('hi')]);
    });

    it('returns a copy — mutation does not affect internals', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      const ctx = cs.getContextMessages();
      ctx.push(asst('injected'));
      expect(cs.length).toBe(2);
    });
  });

  // ===== append =====

  describe('append', () => {
    it('appends messages to the tail', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      cs.append(asst('reply'));
      expect(cs.length).toBe(3);
      expect(cs.toArray()[2]).toEqual(asst('reply'));
    });

    it('supports multiple messages in one call', () => {
      const cs = new ConversationState(null, [], user('hi'));
      cs.append(asst('a'), user('b'));
      expect(cs.length).toBe(3);
    });
  });

  // ===== replaceAt / removeAt — root slot 保护 =====

  describe('root slot protection', () => {
    it('replaceAt throws when targeting slot[0] with root prompt', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      expect(() => cs.replaceAt(0, sys('evil'))).toThrow('Cannot replace root system prompt');
    });

    it('replaceAt allows slot[0] when no root prompt', () => {
      const cs = new ConversationState(null, [asst('old')], user('hi'));
      cs.replaceAt(0, asst('new'));
      expect(cs.toArray()[0]).toEqual(asst('new'));
    });

    it('removeAt throws when targeting slot[0] with root prompt', () => {
      const cs = new ConversationState(sys('root'), [], user('hi'));
      expect(() => cs.removeAt(0)).toThrow('Cannot remove root system prompt');
    });

    it('removeAt allows slot[0] when no root prompt', () => {
      const cs = new ConversationState(null, [asst('extra')], user('hi'));
      cs.removeAt(0);
      expect(cs.length).toBe(1);
      expect(cs.toArray()[0]).toEqual(user('hi'));
    });
  });

  // ===== insertAfterSystemBlock =====

  describe('insertAfterSystemBlock', () => {
    it('inserts after contiguous system messages at head', () => {
      const catalogMsg = sys('catalog', { _systemSource: 'catalog' });
      const cs = new ConversationState(sys('root'), [catalogMsg], user('hi'));
      const injected = sys('new-catalog', { _systemSource: 'catalog' });
      cs.insertAfterSystemBlock(injected);
      const arr = cs.toArray();
      // root, catalog, new-catalog, user
      expect(arr[0]).toEqual(sys('root'));
      expect(arr[2]).toEqual(injected);
      expect(arr[3]).toEqual(user('hi'));
    });

    it('appends when all messages are system', () => {
      const cs = new ConversationState(sys('root'), [sys('a')], sys('b'));
      cs.insertAfterSystemBlock(sys('new'));
      expect(cs.toArray()[cs.length - 1]).toEqual(sys('new'));
    });
  });

  // ===== replaceContent — compaction =====

  describe('replaceContent', () => {
    it('preserves root prompt while replacing everything else', () => {
      const cs = new ConversationState(sys('root'), [asst('old1'), user('old2')], user('old3'));
      expect(cs.length).toBe(4);

      cs.replaceContent([asst('summary'), user('continue')]);
      const arr = cs.toArray();
      expect(arr[0]).toEqual(sys('root'));
      expect(arr[1]).toEqual(asst('summary'));
      expect(arr[2]).toEqual(user('continue'));
      expect(cs.length).toBe(3);
    });

    it('replaces all content when no root prompt', () => {
      const cs = new ConversationState(null, [asst('old')], user('old'));
      cs.replaceContent([asst('new')]);
      expect(cs.toArray()).toEqual([asst('new')]);
    });

    it('can empty non-root content', () => {
      const cs = new ConversationState(sys('root'), [asst('old')], user('old'));
      cs.replaceContent([]);
      expect(cs.length).toBe(1);
      expect(cs.toArray()[0]).toEqual(sys('root'));
    });
  });

  // ===== findIndex =====

  describe('findIndex', () => {
    it('finds the first message matching predicate', () => {
      const cs = new ConversationState(sys('root'), [asst('a')], user('b'));
      expect(cs.findIndex((m) => m.role === 'user')).toBe(2);
    });

    it('returns -1 when no match', () => {
      const cs = new ConversationState(null, [], user('hi'));
      expect(cs.findIndex((m) => m.role === 'assistant')).toBe(-1);
    });
  });
});
