function requireNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Runtime regression metric ${name} is missing or non-finite`);
  }
  return value;
}

function evaluateMetric(name, value, threshold) {
  const failures = [];
  if (threshold.minimum !== undefined && value < threshold.minimum) {
    failures.push(`${name}=${value} is below minimum ${threshold.minimum}`);
  }
  if (threshold.maximum !== undefined && value > threshold.maximum) {
    failures.push(`${name}=${value} exceeds maximum ${threshold.maximum}`);
  }
  return {
    name,
    value,
    ...threshold,
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateRuntimeRegression(policy, sourceReports) {
  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported runtime regression policy ${policy.schemaVersion}`);
  }
  const { stable, recovery } = sourceReports;
  const metrics = {
    storeInitializationMs: requireNumber(
      stable.metrics?.storeInitializationMs,
      'storeInitializationMs',
    ),
    firstClaimLatencyMs: requireNumber(stable.metrics?.firstClaimLatencyMs, 'firstClaimLatencyMs'),
    sessionThroughputPerSecond: requireNumber(
      stable.metrics?.sessionThroughputPerSecond,
      'sessionThroughputPerSecond',
    ),
    sessionCompletionDurationMs: requireNumber(
      stable.metrics?.sessionCompletionDurationMs,
      'sessionCompletionDurationMs',
    ),
    recoveryDurationMs: requireNumber(stable.metrics?.recoveryDurationMs, 'recoveryDurationMs'),
    eventLossRate: requireNumber(stable.metrics?.eventLossRate, 'eventLossRate'),
    processTerminationMs: requireNumber(
      recovery.metrics?.processTerminationMs,
      'processTerminationMs',
    ),
    leaseExpiryWaitMs: requireNumber(recovery.metrics?.leaseExpiryWaitMs, 'leaseExpiryWaitMs'),
    failureDetectionMs: requireNumber(recovery.metrics?.failureDetectionMs, 'failureDetectionMs'),
    recoveryScanMs: requireNumber(recovery.metrics?.recoveryScanMs, 'recoveryScanMs'),
    reclaimAndRestoreMs: requireNumber(
      recovery.metrics?.reclaimAndRestoreMs,
      'reclaimAndRestoreMs',
    ),
    checkpointRestoreMs: requireNumber(
      recovery.metrics?.checkpointRestoreMs,
      'checkpointRestoreMs',
    ),
    fullRecoveryRtoMs: requireNumber(recovery.metrics?.fullRecoveryRtoMs, 'fullRecoveryRtoMs'),
  };
  const sampleSize = {
    sessions: requireNumber(stable.sampleSize?.sessions, 'sampleSize.sessions'),
    events: requireNumber(stable.sampleSize?.events, 'sampleSize.events'),
  };
  const sampleChecks = Object.entries(policy.minimumSampleSize).map(([name, minimum]) => ({
    name: `sampleSize.${name}`,
    value: sampleSize[name],
    minimum,
    passed: sampleSize[name] >= minimum,
    failures:
      sampleSize[name] >= minimum
        ? []
        : [`sampleSize.${name}=${sampleSize[name]} is below minimum ${minimum}`],
  }));
  const metricChecks = Object.entries(policy.thresholds).map(([name, threshold]) =>
    evaluateMetric(name, metrics[name], threshold),
  );
  const checks = [...sampleChecks, ...metricChecks];
  const failures = checks.flatMap((check) => check.failures);
  return {
    passed: failures.length === 0,
    sampleSize,
    metrics,
    checks,
    failures,
  };
}
