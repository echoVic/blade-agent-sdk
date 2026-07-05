import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Node.js version policy', () => {
  it('runs CI verification only on the supported Node.js release line', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'),
    );

    expect(workflow.jobs.verify.strategy.matrix['node-version']).toEqual(['22']);
  });

  it('advertises the same runtime floor in package metadata', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.engines.node).toBe('>=22.14.0');
  });

  it('pins the pnpm toolchain consistently across local metadata and GitHub workflows', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const workflows = [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/deploy-docs.yml',
    ];

    expect(packageJson.packageManager).toBe('pnpm@11.7.0');

    for (const workflowPath of workflows) {
      const workflow = parse(readFileSync(resolve(workflowPath), 'utf8'));
      const jobs = Object.values(workflow.jobs ?? {}) as Array<{
        steps?: Array<{ uses?: string; with?: Record<string, string> }>;
      }>;
      const setupPnpmSteps = jobs
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses?.startsWith('pnpm/action-setup@'));

      expect(setupPnpmSteps.length, `${workflowPath} pnpm setup step`).toBeGreaterThan(0);
      for (const step of setupPnpmSteps) {
        expect(step.with?.version, `${workflowPath} pnpm version`).toBe('11.7.0');
      }
    }
  });
});
