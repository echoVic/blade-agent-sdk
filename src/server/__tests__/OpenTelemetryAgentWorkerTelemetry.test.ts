import { describe, expect, it, vi } from 'vitest';
import { SessionId, WorkerId } from '../../types/identifiers.js';
import type { AgentWorkerSnapshot } from '../AgentWorker.js';
import { OpenTelemetryAgentWorkerTelemetry } from '../OpenTelemetryAgentWorkerTelemetry.js';

function snapshot(): AgentWorkerSnapshot {
  return {
    workerId: WorkerId('worker-secret'),
    status: 'running',
    health: {
      workerId: WorkerId('worker-secret'),
      status: 'ready',
      live: true,
      ready: true,
      workerStatus: 'running',
      checkedAt: '2026-08-26T00:00:00.000Z',
      activeSessions: 1,
      lastHeartbeatAt: '2026-08-26T00:00:00.000Z',
      heartbeatAgeMs: 0,
    },
    activeSessionIds: [SessionId('session-secret')],
    metrics: {
      startedAt: '2026-08-26T00:00:00.000Z',
      firstClaimLatencyMs: 10,
      sessionClaims: 3,
      sessionsIdle: 1,
      sessionsCompleted: 1,
      sessionsSuspended: 0,
      sessionsFailed: 1,
      recoveryRuns: 2,
      recoveryDurationMs: 8,
      activeSessions: 1,
      elapsedMs: 100,
      completedSessionsPerSecond: 20,
    },
    effectMetrics: {
      claimed: 2,
      completed: 1,
      failed: 0,
      retried: 0,
      uncertain: 1,
      handlerDurationMs: 4,
    },
  };
}

describe('OpenTelemetryAgentWorkerTelemetry', () => {
  it('exports payload-free worker gauges and errors', () => {
    const callbacks = new Map<
      string,
      (result: { observe(value: number, attributes?: Record<string, unknown>): void }) => void
    >();
    const add = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add })),
      createObservableGauge: vi.fn((name: string) => ({
        addCallback: (callback: typeof callbacks extends Map<string, infer T> ? T : never) => {
          callbacks.set(name, callback);
        },
      })),
    };
    const telemetry = new OpenTelemetryAgentWorkerTelemetry({
      meter: meter as never,
    });

    telemetry.recordSnapshot(snapshot());
    const observations = Object.fromEntries(
      [...callbacks].map(([name, callback]) => {
        const observe = vi.fn();
        callback({ observe });
        return [name, observe];
      }),
    );
    telemetry.recordError({
      workerId: WorkerId('worker-secret'),
      workerStatus: 'running',
      errorCode: 'EFFECT_LEASE_LOST',
    });

    expect(Object.keys(observations)).toEqual([
      'blade.agent.worker.ready',
      'blade.agent.worker.active_sessions',
      'blade.agent.worker.session.claims',
      'blade.agent.worker.session.completed',
      'blade.agent.worker.session.failed',
      'blade.agent.worker.recovery.duration',
      'blade.agent.worker.effect.uncertain',
    ]);
    for (const [name, value] of [
      ['blade.agent.worker.ready', 1],
      ['blade.agent.worker.active_sessions', 1],
      ['blade.agent.worker.session.claims', 3],
      ['blade.agent.worker.session.completed', 2],
      ['blade.agent.worker.session.failed', 1],
      ['blade.agent.worker.recovery.duration', 8],
      ['blade.agent.worker.effect.uncertain', 1],
    ] as const) {
      expect(observations[name]).toHaveBeenCalledWith(value, {
        'blade.agent.worker.status': 'running',
      });
    }
    expect(add).toHaveBeenCalledWith(1, {
      'blade.agent.worker.status': 'running',
      'error.type': 'EFFECT_LEASE_LOST',
    });
    const exported = JSON.stringify({
      observations: Object.fromEntries(
        Object.entries(observations).map(([name, observe]) => [name, observe.mock.calls]),
      ),
      add: add.mock.calls,
    });
    expect(exported).not.toContain('session-secret');
    expect(exported).not.toContain('worker-secret');
  });
});
