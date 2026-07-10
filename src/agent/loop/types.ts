import type { ToolCall } from '@blade-ai/ai/chat';

export type FunctionToolCall = ToolCall & {
  type: 'function';
  function: { name: string; arguments: string };
};
