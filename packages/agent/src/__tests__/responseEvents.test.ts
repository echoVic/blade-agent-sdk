import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopResponseEvents,
  buildAgentLoopResponseEventsInput,
  emitAgentLoopResponseEventsFromTurnResult,
} from '../loop/responseEvents.js';

describe('agent loop response event projection', () => {
  it('emits thinking content before the stream closes for a text response', () => {
    expect(
      buildAgentLoopResponseEvents({
        reasoningContent: 'thinking out loud',
        content: 'final answer',
        aborted: false,
        hasStreamingExecutionResults: false,
      }),
    ).toEqual([
      { type: 'thinking', content: 'thinking out loud' },
      { type: 'stream_end' },
    ]);
  });

  it('does not emit stream_end for streaming tool execution results', () => {
    expect(
      buildAgentLoopResponseEvents({
        reasoningContent: 'thinking',
        content: 'tool call response',
        aborted: false,
        hasStreamingExecutionResults: true,
      }),
    ).toEqual([{ type: 'thinking', content: 'thinking' }]);
  });

  it('does not emit stream_end for blank content', () => {
    expect(
      buildAgentLoopResponseEvents({
        content: '   ',
        aborted: false,
        hasStreamingExecutionResults: false,
      }),
    ).toEqual([]);
  });

  it('does not emit response events after abort', () => {
    expect(
      buildAgentLoopResponseEvents({
        reasoningContent: 'thinking',
        content: 'final answer',
        aborted: true,
        hasStreamingExecutionResults: false,
      }),
    ).toEqual([]);
  });

  it('builds response event input from a model response and loop state', () => {
    const signal = new AbortController().signal;

    expect(
      buildAgentLoopResponseEventsInput({
        response: {
          reasoningContent: 'thinking',
          content: 'answer',
        },
        signal,
        streamingExecutionResults: undefined,
      }),
    ).toEqual({
      reasoningContent: 'thinking',
      content: 'answer',
      aborted: false,
      hasStreamingExecutionResults: false,
    });
  });

  it('marks response event input as aborted and streaming-tool handled', () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      buildAgentLoopResponseEventsInput({
        response: {
          content: 'answer',
        },
        signal: controller.signal,
        streamingExecutionResults: [{ toolCall: 'placeholder' }],
      }),
    ).toEqual({
      reasoningContent: undefined,
      content: 'answer',
      aborted: true,
      hasStreamingExecutionResults: true,
    });
  });

  it('emits response events from a turn result in order', async () => {
    const responseStream = emitAgentLoopResponseEventsFromTurnResult({
      response: {
        reasoningContent: 'thinking',
        content: 'answer',
      },
      signal: undefined,
      streamingExecutionResults: undefined,
    });

    await expect(responseStream.next()).resolves.toEqual({
      value: { type: 'thinking', content: 'thinking' },
      done: false,
    });
    await expect(responseStream.next()).resolves.toEqual({
      value: { type: 'stream_end' },
      done: false,
    });
    await expect(responseStream.next()).resolves.toEqual({
      value: [
        { type: 'thinking', content: 'thinking' },
        { type: 'stream_end' },
      ],
      done: true,
    });
  });

  it('does not emit response events from an aborted turn result', async () => {
    const controller = new AbortController();
    controller.abort();

    const responseStream = emitAgentLoopResponseEventsFromTurnResult({
      response: {
        reasoningContent: 'thinking',
        content: 'answer',
      },
      signal: controller.signal,
      streamingExecutionResults: undefined,
    });

    await expect(responseStream.next()).resolves.toEqual({
      value: [],
      done: true,
    });
  });
});
