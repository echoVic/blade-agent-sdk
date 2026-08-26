import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function collectActionReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectActionReferences);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    key === 'uses' && typeof nested === 'string'
      ? [nested]
      : collectActionReferences(nested),
  );
}

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

  it('uses Node.js 24-backed GitHub Action majors in every workflow', () => {
    const workflowDirectory = resolve('.github/workflows');
    const actionReferences = readdirSync(workflowDirectory)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .flatMap((name) =>
        collectActionReferences(
          parse(readFileSync(resolve(workflowDirectory, name), 'utf8')),
        ),
      );

    expect([...new Set(actionReferences)].sort()).toEqual([
      'actions/checkout@v5',
      'actions/configure-pages@v6',
      'actions/deploy-pages@v5',
      'actions/setup-node@v7',
      'actions/upload-artifact@v6',
      'actions/upload-pages-artifact@v5',
      'pnpm/action-setup@v6',
    ]);
  });
});
