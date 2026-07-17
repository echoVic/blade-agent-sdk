/**
 * Session type definitions extracted from root session/types.ts.
 * Zero root class dependencies.
 */

import type { JsonValue, TokenUsage } from '../types/common.js';

export interface ToolCallRecord {
  id: string;
  name: string;
  input: JsonValue;
  output: string | object;
  duration: number;
  isError?: boolean;
}

export interface PromptResult {
  result: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  duration: number;
}
