import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The policy evaluator is an executable JavaScript module.
import { evaluateRuntimeRegression } from '../runtime-regression-policy.mjs';

const policy = JSON.parse(
  readFileSync('benchmarks/runtime-regression-policy.json', 'utf8'),
);

interface SourceReports {
  stable: {
    sampleSize: {
      sessions: number;
      events: number;
      effects: number;
    };
    metrics: Record<string, number>;
  };
  recovery: {
    metrics: Record<string, number>;
  };
  faults: {
    sampleSize: {
      crashPoints: number;
    };
    metrics: Record<string, number>;
    matrix: Array<{
      crashPoint: string;
      passed: boolean;
    }>;
  };
}

function sourceReports(): SourceReports {
  return {
    stable: {
      sampleSize: {
        sessions: 100,
        events: 1_000,
        effects: 100,
      },
      metrics: {
        storeInitializationMs: 100,
        firstClaimLatencyMs: 10,
        sessionThroughputPerSecond: 100,
        sessionCompletionDurationMs: 1_000,
        recoveryDurationMs: 20,
        eventLossRate: 0,
        nonIdempotentDuplicateRate: 0,
      },
    },
    recovery: {
      metrics: {
        processTerminationMs: 10,
        leaseExpiryWaitMs: 1_000,
        failureDetectionMs: 1_050,
        recoveryScanMs: 20,
        reclaimAndRestoreMs: 1_500,
        checkpointRestoreMs: 500,
        fullRecoveryRtoMs: 2_550,
      },
    },
    faults: {
      sampleSize: {
        crashPoints: 4,
      },
      metrics: {
        passRate: 1,
        duplicateRate: 0,
        maximumRecoveryRtoMs: 1_100,
      },
      matrix: [
        { crashPoint: 'after_claim', passed: true },
        { crashPoint: 'after_start', passed: true },
        { crashPoint: 'after_side_effect', passed: true },
        { crashPoint: 'after_complete', passed: true },
      ],
    },
  };
}

describe('runtime regression policy', () => {
  it('accepts a complete report within every threshold', () => {
    const result = evaluateRuntimeRegression(policy, sourceReports());

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(
      result.checks.every((check: { passed: boolean }) => check.passed),
    ).toBe(true);
  });

  it('rejects reduced samples and metric regressions', () => {
    const reports = sourceReports();
    reports.stable.sampleSize.events = 999;
    reports.stable.metrics.sessionThroughputPerSecond = 19;
    reports.recovery.metrics.fullRecoveryRtoMs = 15_001;
    reports.faults.metrics.duplicateRate = 0.01;

    const result = evaluateRuntimeRegression(policy, reports);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sampleSize.events=999'),
        expect.stringContaining('sessionThroughputPerSecond=19'),
        expect.stringContaining('fullRecoveryRtoMs=15001'),
        expect.stringContaining('faultInjectionDuplicateRate=0.01'),
      ]),
    );
  });

  it('rejects an incomplete or failed crash matrix', () => {
    const reports = sourceReports();
    reports.faults.matrix = reports.faults.matrix.slice(0, 3);
    reports.faults.metrics.passRate = 0.75;

    const result = evaluateRuntimeRegression(policy, reports);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('faultInjectionPassRate=0.75'),
        'Fault injection matrix is incomplete or contains a failed crash point',
      ]),
    );
  });
});
