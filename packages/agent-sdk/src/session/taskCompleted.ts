import { countUserMessageImages, getUserMessageText } from './content.js';
import type { SessionId, UserMessageContent } from './types.js';

export interface TaskCompletedHookRuntime {
  runTaskCompleted(payload: {
    taskId: SessionId;
    taskDescription: string;
    hasImages: boolean;
    imageCount: number;
    resultSummary: string;
    success: boolean;
  }): Promise<void> | void;
}

export interface ReportSessionTaskCompletedOptions {
  hookRuntime: TaskCompletedHookRuntime;
  sessionId: SessionId;
  message: UserMessageContent;
  resultSummary: string;
  success: boolean;
}

export async function reportSessionTaskCompleted(
  options: ReportSessionTaskCompletedOptions,
): Promise<void> {
  const imageCount = countUserMessageImages(options.message);
  await options.hookRuntime.runTaskCompleted({
    taskId: options.sessionId,
    taskDescription: getUserMessageText(options.message),
    hasImages: imageCount > 0,
    imageCount,
    resultSummary: options.resultSummary,
    success: options.success,
  });
}
