import { describe, expect, it } from 'vitest';
import { HealthStatus } from '../local/index.js';
import type { HealthCheckConfig } from '../local/index.js';

describe('HealthStatus', () => {
  it('defines all expected status values', () => {
    expect(HealthStatus.HEALTHY).toBe('healthy');
    expect(HealthStatus.DEGRADED).toBe('degraded');
    expect(HealthStatus.UNHEALTHY).toBe('unhealthy');
    expect(HealthStatus.CHECKING).toBe('checking');
  });

  it('has four members', () => {
    const values = Object.values(HealthStatus).filter((v) => typeof v === 'string');
    expect(values).toHaveLength(4);
  });
});

describe('HealthCheckConfig', () => {
  it('accepts empty config', () => {
    const config: HealthCheckConfig = {};
    expect(config.enabled).toBeUndefined();
  });

  it('accepts full config', () => {
    const config: HealthCheckConfig = {
      interval: 30000,
      timeout: 10000,
      enabled: true,
      failureThreshold: 3,
    };
    expect(config.interval).toBe(30000);
    expect(config.failureThreshold).toBe(3);
  });
});
