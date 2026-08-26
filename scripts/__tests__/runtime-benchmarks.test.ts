import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RuntimeBenchmark {
  sampleSize: {
    sessions: number;
    events: number;
    effects: number;
  };
  metrics: {
    storeInitializationMs: number;
    firstClaimLatencyMs: number;
    sessionThroughputPerSecond: number;
    sessionCompletionDurationMs: number;
    recoveryDurationMs: number;
    eventLossRate: number;
    nonIdempotentDuplicateRate: number;
  };
}

interface RuntimeRegressionPolicy {
  schemaVersion: number;
  minimumSampleSize: Record<string, number>;
  thresholds: Record<
    string,
    { minimum?: number; maximum?: number }
  >;
}

describe('runtime benchmark publication', () => {
  it('publishes a complete machine-readable baseline', () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve('benchmarks/baselines/2026-08-26-darwin-arm64.json'),
        'utf8',
      ),
    ) as RuntimeBenchmark;

    expect(baseline.sampleSize).toEqual({
      sessions: 100,
      events: 1000,
      effects: 100,
    });
    expect(baseline.metrics).toMatchObject({
      eventLossRate: 0,
      nonIdempotentDuplicateRate: 0,
    });
    expect(baseline.metrics.storeInitializationMs).toBeGreaterThan(0);
    expect(baseline.metrics.firstClaimLatencyMs).toBeGreaterThanOrEqual(0);
    expect(baseline.metrics.sessionThroughputPerSecond).toBeGreaterThan(0);
    expect(baseline.metrics.sessionCompletionDurationMs).toBeGreaterThan(0);
    expect(baseline.metrics.recoveryDurationMs).toBeGreaterThan(0);
  });

  it('keeps the benchmark command connected to its script', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['benchmark:runtime']).toBe(
      'pnpm run build && node benchmarks/runtime.mjs',
    );
    expect(packageJson.scripts['verify:runtime-regression']).toBe(
      'node scripts/verify-runtime-regression.mjs',
    );
  });

  it('gates the complete steady-state and failure metric set', () => {
    const policy = JSON.parse(
      readFileSync(
        resolve('benchmarks/runtime-regression-policy.json'),
        'utf8',
      ),
    ) as RuntimeRegressionPolicy;

    expect(policy.schemaVersion).toBe(1);
    expect(policy.minimumSampleSize).toEqual({
      sessions: 100,
      events: 1000,
      effects: 100,
      crashPoints: 4,
    });
    expect(Object.keys(policy.thresholds).sort()).toEqual([
      'checkpointRestoreMs',
      'eventLossRate',
      'failureDetectionMs',
      'faultInjectionDuplicateRate',
      'faultInjectionPassRate',
      'firstClaimLatencyMs',
      'fullRecoveryRtoMs',
      'leaseExpiryWaitMs',
      'maximumFaultRecoveryRtoMs',
      'nonIdempotentDuplicateRate',
      'processTerminationMs',
      'reclaimAndRestoreMs',
      'recoveryDurationMs',
      'recoveryScanMs',
      'sessionCompletionDurationMs',
      'sessionThroughputPerSecond',
      'storeInitializationMs',
    ]);
    expect(policy.thresholds.eventLossRate?.maximum).toBe(0);
    expect(policy.thresholds.nonIdempotentDuplicateRate?.maximum).toBe(0);
    expect(policy.thresholds.faultInjectionDuplicateRate?.maximum).toBe(0);
    expect(policy.thresholds.faultInjectionPassRate?.minimum).toBe(1);

    const faultSource = readFileSync(
      resolve('benchmarks/fault-injection.mjs'),
      'utf8',
    );
    for (const crashPoint of [
      'after_claim',
      'after_start',
      'after_side_effect',
      'after_complete',
    ]) {
      expect(faultSource).toContain(`name: '${crashPoint}'`);
    }

    const recoverySource = readFileSync(
      resolve('examples/postgres-worker-recovery/run.mjs'),
      'utf8',
    );
    for (const metric of [
      'processTerminationMs',
      'leaseExpiryWaitMs',
      'failureDetectionMs',
      'recoveryScanMs',
      'reclaimAndRestoreMs',
      'checkpointRestoreMs',
      'fullRecoveryRtoMs',
    ]) {
      expect(recoverySource).toContain(metric);
    }
  });
});
