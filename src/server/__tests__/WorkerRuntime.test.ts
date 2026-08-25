import { describe, expect, it } from 'vitest';
import {
  assertRuntimeSessionTransition,
  canTransitionRuntimeSession,
  RUNTIME_SESSION_STATES,
} from '../WorkerRuntime.js';

const allowedTransitions = {
  queued: ['queued', 'provisioning', 'failed'],
  provisioning: ['provisioning', 'running', 'suspended', 'failed'],
  running: [
    'running',
    'waiting_approval',
    'suspended',
    'completed',
    'failed',
  ],
  waiting_approval: [
    'waiting_approval',
    'running',
    'suspended',
    'failed',
  ],
  suspended: ['suspended', 'queued', 'provisioning', 'completed', 'failed'],
  completed: ['completed'],
  failed: ['failed'],
} as const;

describe('Worker Runtime state machine', () => {
  it('defines every transition for every state', () => {
    for (const from of RUNTIME_SESSION_STATES) {
      for (const to of RUNTIME_SESSION_STATES) {
        const allowed = allowedTransitions[from].includes(to as never);
        expect(
          canTransitionRuntimeSession(from, to),
          `${from} -> ${to}`,
        ).toBe(allowed);
        if (allowed) {
          expect(() => assertRuntimeSessionTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertRuntimeSessionTransition(from, to)).toThrow(
            /cannot transition/,
          );
        }
      }
    }
  });
});
