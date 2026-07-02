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
});
