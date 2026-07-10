import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBrowserClientRootSdkImportViolations } from '../docsBrowserImportPolicy.js';

describe('docs browser/client SDK import policy', () => {
  it('flags root SDK imports inside browser/client documentation sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blade-docs-import-policy-'));
    const docPath = join(dir, 'browser-guide.md');
    writeFileSync(
      docPath,
      [
        '# Browser Guide',
        '',
        '## Client Boundary',
        '',
        '```ts',
        "import { createSession } from '@blade-ai/agent-sdk';",
        '```',
        '',
        '## Server Route',
        '',
        '```ts',
        "import { createSession } from '@blade-ai/agent-sdk';",
        '```',
        '',
      ].join('\n'),
    );

    expect(findBrowserClientRootSdkImportViolations([docPath])).toEqual([
      {
        file: docPath,
        line: 6,
        section: 'Client Boundary',
        specifier: '@blade-ai/agent-sdk',
      },
    ]);
  });

  it('keeps repository browser/client documentation on browser-safe SDK subpaths', () => {
    const docs = [
      'README.md',
      'packages/agent-sdk/README.md',
      ...readdirSync('docs')
        .filter((name) => name.endsWith('.md'))
        .map((name) => join('docs', name)),
    ];

    expect(findBrowserClientRootSdkImportViolations(docs)).toEqual([]);
  });
});
