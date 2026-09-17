import type { SessionId } from '../../types/identifiers.js';
import type { ExecutionContext } from '../types/execution.js';

export function requireSessionId(context: Pick<ExecutionContext, 'sessionId'>): SessionId {
  if (!context.sessionId) {
    throw new TypeError('Tool execution requires a sessionId');
  }
  return context.sessionId;
}
