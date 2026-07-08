import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopRunTurnInput,
  buildAgentLoopRunTurnInputFromLoopState,
  buildAgentLoopRunTurnInputFromTurnProjection,
  buildAgentLoopRunTurnToolHooksInput,
  consumeAgentLoopTurnStream,
} from '../loop/turnStream.js';

describe('agent loop turn stream consumption', () => {
  it('projects root run-turn input without owning runtime side effects', () => {
    const turnState = { id: 'turn-state' };
    const messages = [{ role: 'user', content: 'hello' }] as const;
    const executionPipeline = { name: 'pipeline' };
    const signal = new AbortController().signal;
    const epoch = { id: 'epoch' };
    const executionContext = { cwd: '/tmp/project' };
    const logger = { debug: () => undefined };
    const toolHooks = {
      onUpdate: () => undefined,
    };

    expect(
      buildAgentLoopRunTurnInput({
        turnState,
        messages,
        executionPipeline,
        streaming: true,
        signal,
        epoch,
        executionContext,
        permissionMode: 'acceptEdits',
        logger,
        toolHooks,
      }),
    ).toEqual({
      turnState,
      messages,
      executionPipeline,
      streaming: true,
      signal,
      epoch,
      executionContext,
      permissionMode: 'acceptEdits',
      logger,
      toolHooks,
    });
  });

  it('projects run-turn input from a turn state projection', () => {
    const turnState = {
      id: 'turn-state',
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'acceptEdits',
    };
    const messages = [{ role: 'user', content: 'hello' }] as const;
    const executionPipeline = { name: 'pipeline' };
    const signal = new AbortController().signal;
    const epoch = { id: 'epoch' };
    const logger = { debug: () => undefined };
    const toolHooks = {
      onUpdate: () => undefined,
    };

    expect(
      buildAgentLoopRunTurnInputFromTurnProjection({
        turnStateProjection: {
          turnState,
          maxContextTokens: turnState.maxContextTokens,
          executionContext: turnState.executionContext,
          permissionMode: turnState.permissionMode,
        },
        messages,
        executionPipeline,
        streaming: true,
        signal,
        epoch,
        logger,
        toolHooks,
      }),
    ).toEqual({
      turnState,
      messages,
      executionPipeline,
      streaming: true,
      signal,
      epoch,
      executionContext: turnState.executionContext,
      permissionMode: turnState.permissionMode,
      logger,
      toolHooks,
    });
  });

  it('projects run-turn input from loop state objects and session tool hooks', () => {
    const turnState = {
      id: 'turn-state',
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'acceptEdits',
    };
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const executionPipeline = { name: 'pipeline' };
    const signal = new AbortController().signal;
    const epoch = { id: 'epoch' };
    const logger = { debug: () => undefined };
    const beforeExec = () => Promise.resolve(null);
    const afterExec = () => Promise.resolve();
    const afterExecEpochDiscard = () => Promise.resolve();
    const onUpdate = () => undefined;

    expect(
      buildAgentLoopRunTurnInputFromLoopState({
        turnStateProjection: {
          turnState,
          maxContextTokens: turnState.maxContextTokens,
          executionContext: turnState.executionContext,
          permissionMode: turnState.permissionMode,
        },
        conversation: {
          toArray: () => messages,
        },
        executionPipeline,
        streaming: true,
        signal,
        epoch,
        logger,
        toolHooks: {
          beforeExec,
          afterExec,
          afterExecEpochDiscard,
          onUpdate,
        },
      }),
    ).toEqual({
      turnState,
      messages,
      executionPipeline,
      streaming: true,
      signal,
      epoch,
      executionContext: turnState.executionContext,
      permissionMode: turnState.permissionMode,
      logger,
      toolHooks: {
        onBeforeExec: beforeExec,
        onAfterExec: afterExec,
        onAfterExecEpochDiscard: afterExecEpochDiscard,
        onUpdate,
      },
    });
  });

  it('projects run-turn tool hooks from session hook names', () => {
    const beforeExec = () => Promise.resolve(null);
    const afterExec = () => Promise.resolve();
    const afterExecEpochDiscard = () => Promise.resolve();
    const onUpdate = () => undefined;

    expect(
      buildAgentLoopRunTurnToolHooksInput({
        beforeExec,
        afterExec,
        afterExecEpochDiscard,
        onUpdate,
      }),
    ).toEqual({
      onBeforeExec: beforeExec,
      onAfterExec: afterExec,
      onAfterExecEpochDiscard: afterExecEpochDiscard,
      onUpdate,
    });
  });

  it('passes through run-turn events and projects the terminal outcome', async () => {
    async function* runTurnStream(): AsyncGenerator<
      { type: 'stream_delta'; content: string },
      {
        chatResponse: { content: string };
        streamingExecutionResults?: Array<{ toolUseUuid: string | null }>;
      }
    > {
      yield { type: 'stream_delta', content: 'hello' };
      return {
        chatResponse: { content: 'done' },
        streamingExecutionResults: [{ toolUseUuid: null }],
      };
    }

    const consumed = consumeAgentLoopTurnStream(runTurnStream());

    await expect(consumed.next()).resolves.toEqual({
      value: { type: 'stream_delta', content: 'hello' },
      done: false,
    });
    await expect(consumed.next()).resolves.toEqual({
      value: {
        turnResult: { content: 'done' },
        streamingExecutionResults: [{ toolUseUuid: null }],
      },
      done: true,
    });
  });
});
