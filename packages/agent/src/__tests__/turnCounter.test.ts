import { describe, expect, it } from 'vitest';
import {
  beginAgentLoopTurn,
  buildAgentLoopBeforeTurnHookPayload,
  buildAgentLoopBeforeTurnHookPayloadFromConversation,
  consumeAgentLoopBeforeTurnStream,
  createAgentLoopTurnCounter,
  requestAgentLoopTurnRetry,
  resetAgentLoopTurnCounter,
  shouldEmitAgentLoopTurnStart,
  shouldRunAgentLoopBeforeTurnHook,
} from '../loop/turnCounter.js';

describe('agent loop turn counter', () => {
  it('starts before the first turn and allows before-turn hooks', () => {
    const counter = createAgentLoopTurnCounter();

    expect(counter.turnsCount).toBe(0);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
    expect(counter.previousCompletedTurnCount).toBe(0);
  });

  it('starts new turns by incrementing the visible turn count', () => {
    const counter = createAgentLoopTurnCounter();

    expect(counter.beginTurn()).toEqual({ started: true, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.previousCompletedTurnCount).toBe(0);

    expect(counter.beginTurn()).toEqual({ started: true, turn: 2 });
    expect(counter.turnsCount).toBe(2);
    expect(counter.previousCompletedTurnCount).toBe(1);
  });

  it('starts turns through the loop helper', () => {
    const counter = createAgentLoopTurnCounter();

    expect(beginAgentLoopTurn({ counter })).toEqual({ started: true, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.previousCompletedTurnCount).toBe(0);

    expect(beginAgentLoopTurn({ counter })).toEqual({ started: true, turn: 2 });
    expect(counter.turnsCount).toBe(2);
    expect(counter.previousCompletedTurnCount).toBe(1);
  });

  it('emits turn-start events only for newly started turns', () => {
    expect(shouldEmitAgentLoopTurnStart({ started: true, turn: 1 })).toBe(true);
    expect(shouldEmitAgentLoopTurnStart({ started: false, turn: 1 })).toBe(false);
  });

  it('runs before-turn hooks only when the counter allows it and a hook exists', () => {
    const counter = createAgentLoopTurnCounter();
    const hook = () => undefined;

    expect(shouldRunAgentLoopBeforeTurnHook(counter, hook)).toBe(true);
    expect(shouldRunAgentLoopBeforeTurnHook(counter, undefined)).toBe(false);

    counter.beginTurn();
    counter.requestRetry();

    expect(shouldRunAgentLoopBeforeTurnHook(counter, hook)).toBe(false);
  });

  it('retries the current turn without rerunning before-turn hooks or incrementing', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    counter.requestRetry();

    expect(counter.shouldRunBeforeTurn()).toBe(false);
    expect(counter.beginTurn()).toEqual({ started: false, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
  });

  it('requests current-turn retry through the loop helper', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    requestAgentLoopTurnRetry({ counter });

    expect(counter.shouldRunBeforeTurn()).toBe(false);
    expect(counter.beginTurn()).toEqual({ started: false, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
  });

  it('resets turn counting after turn-limit compaction continues the loop', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    counter.beginTurn();
    counter.requestRetry();
    counter.reset();

    expect(counter.turnsCount).toBe(0);
    expect(counter.previousCompletedTurnCount).toBe(0);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
    expect(counter.beginTurn()).toEqual({ started: true, turn: 1 });
  });

  it('resets turn counting through the loop helper', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    counter.beginTurn();
    counter.requestRetry();
    resetAgentLoopTurnCounter({ counter });

    expect(counter.turnsCount).toBe(0);
    expect(counter.previousCompletedTurnCount).toBe(0);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
    expect(counter.beginTurn()).toEqual({ started: true, turn: 1 });
  });

  it('consumes before-turn hook stream events and preserves the final return value', async () => {
    async function* beforeTurnStream(): AsyncGenerator<string, boolean> {
      yield 'before-turn-event-1';
      yield 'before-turn-event-2';
      return false;
    }

    const consumed = consumeAgentLoopBeforeTurnStream(beforeTurnStream());

    await expect(consumed.next()).resolves.toEqual({
      value: 'before-turn-event-1',
      done: false,
    });
    await expect(consumed.next()).resolves.toEqual({
      value: 'before-turn-event-2',
      done: false,
    });
    await expect(consumed.next()).resolves.toEqual({
      value: false,
      done: true,
    });
  });

  it('projects before-turn hook payloads with messages and prompt-token context', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];

    expect(
      buildAgentLoopBeforeTurnHookPayload({
        turn: 3,
        messages,
        lastPromptTokens: 42,
      }),
    ).toEqual({
      turn: 3,
      messages,
      lastPromptTokens: 42,
    });
  });

  it('projects before-turn hook payloads from turn counter and conversation state', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const counter = createAgentLoopTurnCounter();
    const conversation = {
      toArray: () => messages,
    };

    counter.beginTurn();
    counter.beginTurn();

    expect(
      buildAgentLoopBeforeTurnHookPayloadFromConversation({
        counter,
        conversation,
        lastPromptTokens: 42,
      }),
    ).toEqual({
      turn: 2,
      messages,
      lastPromptTokens: 42,
    });
  });
});
