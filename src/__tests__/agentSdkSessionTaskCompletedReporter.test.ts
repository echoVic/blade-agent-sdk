import { describe, expect, it, vi } from 'vitest';
import { reportSessionTaskCompleted } from '../../packages/agent-sdk/src/session/taskCompleted.js';

describe('agent-sdk session task completed reporter', () => {
  it('reports text prompts without image metadata', async () => {
    const hookRuntime = {
      runTaskCompleted: vi.fn(),
    };

    await reportSessionTaskCompleted({
      hookRuntime,
      sessionId: 'session-1',
      message: 'Summarize this',
      resultSummary: 'Done',
      success: true,
    });

    expect(hookRuntime.runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'session-1',
      taskDescription: 'Summarize this',
      hasImages: false,
      imageCount: 0,
      resultSummary: 'Done',
      success: true,
    });
  });

  it('joins multimodal text parts and counts image parts', async () => {
    const hookRuntime = {
      runTaskCompleted: vi.fn(),
    };

    await reportSessionTaskCompleted({
      hookRuntime,
      sessionId: 'session-1',
      message: [
        { type: 'text', text: 'Describe' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'text', text: 'Then summarize' },
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
      ],
      resultSummary: 'Two images',
      success: false,
    });

    expect(hookRuntime.runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'session-1',
      taskDescription: 'Describe\nThen summarize',
      hasImages: true,
      imageCount: 2,
      resultSummary: 'Two images',
      success: false,
    });
  });
});
