import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { evaluateRuntimeRegression } from './runtime-regression-policy.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const policyPath = resolve(root, 'benchmarks/runtime-regression-policy.json');
const reportPath = resolve(
  root,
  process.env.RUNTIME_REGRESSION_REPORT_PATH
    || 'artifacts/runtime-regression.json',
);

async function runJson(script, timeoutMs = 120_000) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [resolve(root, script)],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    },
  );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Could not parse JSON from ${script}: ${
        error instanceof Error ? error.message : String(error)
      }\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }
}

const policy = JSON.parse(await readFile(policyPath, 'utf8'));
const stable = await runJson('benchmarks/runtime.mjs');
const recovery = await runJson(
  'examples/postgres-worker-recovery/run.mjs',
);
const faults = await runJson('benchmarks/fault-injection.mjs');
const evaluation = evaluateRuntimeRegression(policy, {
  stable,
  recovery,
  faults,
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  passed: evaluation.passed,
  environment: {
    ...stable.environment,
    dockerImage: process.env.TEST_DOCKER_IMAGE,
  },
  sampleSize: evaluation.sampleSize,
  metrics: evaluation.metrics,
  policy,
  checks: evaluation.checks,
  faultInjectionMatrix: evaluation.faultInjectionMatrix,
  sourceReports: {
    stable,
    recovery,
    faults,
  },
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  passed: report.passed,
  reportPath,
  sampleSize: report.sampleSize,
  metrics: report.metrics,
}, null, 2)}\n`);

if (!evaluation.passed) {
  throw new Error(
    `Runtime regression gate failed:\n- ${evaluation.failures.join('\n- ')}`,
  );
}
