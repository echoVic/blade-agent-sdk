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
  });
});
