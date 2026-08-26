const EXPECTED_CRASH_POINTS = [
  'after_claim',
  'after_start',
  'after_side_effect',
  'after_complete',
];

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
  const { stable, recovery, faults } = sourceReports;
  const metrics = {
    storeInitializationMs: requireNumber(
      stable.metrics?.storeInitializationMs,
      'storeInitializationMs',
    ),
    firstClaimLatencyMs: requireNumber(
      stable.metrics?.firstClaimLatencyMs,
      'firstClaimLatencyMs',
    ),
    sessionThroughputPerSecond: requireNumber(
      stable.metrics?.sessionThroughputPerSecond,
      'sessionThroughputPerSecond',
    ),
    sessionCompletionDurationMs: requireNumber(
      stable.metrics?.sessionCompletionDurationMs,
      'sessionCompletionDurationMs',
    ),
    recoveryDurationMs: requireNumber(
      stable.metrics?.recoveryDurationMs,
      'recoveryDurationMs',
    ),
    eventLossRate: requireNumber(
      stable.metrics?.eventLossRate,
      'eventLossRate',
    ),
    nonIdempotentDuplicateRate: requireNumber(
      stable.metrics?.nonIdempotentDuplicateRate,
      'nonIdempotentDuplicateRate',
    ),
    processTerminationMs: requireNumber(
      recovery.metrics?.processTerminationMs,
      'processTerminationMs',
    ),
    leaseExpiryWaitMs: requireNumber(
      recovery.metrics?.leaseExpiryWaitMs,
      'leaseExpiryWaitMs',
    ),
    failureDetectionMs: requireNumber(
      recovery.metrics?.failureDetectionMs,
      'failureDetectionMs',
    ),
    recoveryScanMs: requireNumber(
      recovery.metrics?.recoveryScanMs,
      'recoveryScanMs',
    ),
    reclaimAndRestoreMs: requireNumber(
      recovery.metrics?.reclaimAndRestoreMs,
      'reclaimAndRestoreMs',
    ),
    checkpointRestoreMs: requireNumber(
      recovery.metrics?.checkpointRestoreMs,
      'checkpointRestoreMs',
    ),
    fullRecoveryRtoMs: requireNumber(
      recovery.metrics?.fullRecoveryRtoMs,
      'fullRecoveryRtoMs',
    ),
    faultInjectionPassRate: requireNumber(
      faults.metrics?.passRate,
      'faultInjectionPassRate',
    ),
    faultInjectionDuplicateRate: requireNumber(
      faults.metrics?.duplicateRate,
      'faultInjectionDuplicateRate',
    ),
    maximumFaultRecoveryRtoMs: requireNumber(
      faults.metrics?.maximumRecoveryRtoMs,
      'maximumFaultRecoveryRtoMs',
    ),
  };
  const sampleSize = {
    sessions: requireNumber(stable.sampleSize?.sessions, 'sampleSize.sessions'),
    events: requireNumber(stable.sampleSize?.events, 'sampleSize.events'),
    effects: requireNumber(stable.sampleSize?.effects, 'sampleSize.effects'),
    crashPoints: requireNumber(
      faults.sampleSize?.crashPoints,
      'sampleSize.crashPoints',
    ),
  };
  const sampleChecks = Object.entries(policy.minimumSampleSize).map(
    ([name, minimum]) => ({
      name: `sampleSize.${name}`,
      value: sampleSize[name],
      minimum,
      passed: sampleSize[name] >= minimum,
      failures:
        sampleSize[name] >= minimum
          ? []
          : [`sampleSize.${name}=${sampleSize[name]} is below minimum ${minimum}`],
    }),
  );
  const metricChecks = Object.entries(policy.thresholds).map(
    ([name, threshold]) =>
      evaluateMetric(name, metrics[name], threshold),
  );
  const faultInjectionMatrix = Array.isArray(faults.matrix)
    ? faults.matrix
    : [];
  const observedCrashPoints = faultInjectionMatrix
    .map((entry) => entry.crashPoint)
    .sort();
  const matrixCheck = {
    name: 'faultInjectionMatrix',
    value: observedCrashPoints,
    expected: [...EXPECTED_CRASH_POINTS].sort(),
    passed:
      JSON.stringify(observedCrashPoints)
      === JSON.stringify([...EXPECTED_CRASH_POINTS].sort())
      && faultInjectionMatrix.every((entry) => entry.passed),
    failures: [],
  };
  if (!matrixCheck.passed) {
    matrixCheck.failures.push(
      'Fault injection matrix is incomplete or contains a failed crash point',
    );
  }
  const checks = [...sampleChecks, ...metricChecks, matrixCheck];
  const failures = checks.flatMap((check) => check.failures);
  return {
    passed: failures.length === 0,
    sampleSize,
    metrics,
    checks,
    failures,
    faultInjectionMatrix,
  };
}
