import { describe, expect, it } from 'vitest';
import { buildAgentLoopResponseEvents } from '../loop/responseEvents.js';

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
});
