import { describe, expect, it } from 'vitest';
import { ConversationState } from '../state/ConversationState.js';
import type { Message } from '@blade-ai/ai/chat';

const mkMsg = (role: Message['role'], content: string): Message =>
  ({ role, content }) as Message;

describe('ConversationState', () => {
  it('stores root system prompt and user message', () => {
    const system = mkMsg('system', 'You are helpful');
    const user = mkMsg('user', 'hello');
    const state = new ConversationState(system, [], user);
    expect(state.length).toBe(2);
    expect(state.hasRootSystemPrompt).toBe(true);
  });

  it('stores context messages', () => {
    const ctx = [mkMsg('user', 'previous'), mkMsg('assistant', 'response')];
    const state = new ConversationState(null, ctx, mkMsg('user', 'new'));
    expect(state.length).toBe(3);
  });

  it('toArray returns shallow copy', () => {
    const state = new ConversationState(null, [], mkMsg('user', 'a'));
    const arr1 = state.toArray();
    expect(arr1).toHaveLength(1);
    // Verify it's a copy by checking that append to state doesn't affect arr1
    state.append(mkMsg('user', 'b'));
    expect(arr1).toHaveLength(1); // original snapshot unchanged
  });

  it('getContextMessages excludes root system prompt', () => {
    const system = mkMsg('system', 'root');
    const state = new ConversationState(system, [], mkMsg('user', 'q'));
    expect(state.hasRootSystemPrompt).toBe(true);
    const ctx = state.getContextMessages();
    expect(ctx).toHaveLength(1);
    expect(ctx[0].role).toBe('user');
  });

  it('append adds messages to the end', () => {
    const state = new ConversationState(null, [], mkMsg('user', 'q'));
    state.append(mkMsg('assistant', 'a'));
    expect(state.length).toBe(2);
    expect(state.toArray()[1].role).toBe('assistant');
  });

  it('insertAfterSystemBlock inserts after system messages', () => {
    const state = new ConversationState(
      mkMsg('system', 'root'),
      [],
      mkMsg('user', 'q'),
    );
    state.insertAfterSystemBlock(mkMsg('system', 'injected'));
    const arr = state.toArray();
    // root system, injected system, user
    expect(arr[0].content).toBe('root');
    expect(arr[1].content).toBe('injected');
    expect(arr[2].content).toBe('q');
  });

  it('replaceAt throws when replacing root system prompt', () => {
    const state = new ConversationState(
      mkMsg('system', 'root'),
      [],
      mkMsg('user', 'q'),
    );
    expect(() => state.replaceAt(0, mkMsg('system', 'bad'))).toThrow(
      'Cannot replace root system prompt',
    );
  });

  it('replaceAt works after root slot', () => {
    const state = new ConversationState(null, [], mkMsg('user', 'old'));
    state.replaceAt(0, mkMsg('user', 'new'));
    expect(state.toArray()[0].content).toBe('new');
  });

  it('removeAt throws when removing root system prompt', () => {
    const state = new ConversationState(
      mkMsg('system', 'root'),
      [],
      mkMsg('user', 'q'),
    );
    expect(() => state.removeAt(0)).toThrow('Cannot remove root system prompt');
  });

  it('removeAt works after root slot', () => {
    const state = new ConversationState(
      null,
      [mkMsg('user', 'a'), mkMsg('assistant', 'b')],
      mkMsg('user', 'c'),
    );
    state.removeAt(1);
    expect(state.length).toBe(2);
  });

  it('findIndex locates message by predicate', () => {
    const state = new ConversationState(
      null,
      [],
      mkMsg('user', 'find me'),
    );
    expect(state.findIndex((m) => m.content === 'find me')).toBe(0);
    expect(state.findIndex((m) => m.role === 'system')).toBe(-1);
  });

  it('replaceContent keeps root system prompt', () => {
    const system = mkMsg('system', 'root');
    const state = new ConversationState(system, [], mkMsg('user', 'original'));
    state.replaceContent([mkMsg('user', 'compacted')]);
    const arr = state.toArray();
    expect(arr).toHaveLength(2);
    expect(arr[0].content).toBe('root');
    expect(arr[1].content).toBe('compacted');
  });

  it('length reflects message count', () => {
    const state = new ConversationState(
      null,
      [mkMsg('user', 'a'), mkMsg('assistant', 'b')],
      mkMsg('user', 'c'),
    );
    expect(state.length).toBe(3);
  });
});
