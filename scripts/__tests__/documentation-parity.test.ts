import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const publicDocuments = [
  'index.md',
  'blade-agent-sdk.md',
  'providers.md',
  'session.md',
  'server-runtime.md',
  'runtime-store.md',
  'worker-runtime.md',
  'execution-host.md',
  'durable-events.md',
  'tools.md',
  'permissions.md',
  'hooks.md',
  'mcp.md',
  'sandbox.md',
  'agents.md',
  'skills.md',
  'recipes.md',
  'type-architecture.md',
  'api-reference.md',
  'migrating-to-your-repository.md',
] as const;

function changelogVersions(file: string): string[] {
  return Array.from(
    readFileSync(resolve(file), 'utf8').matchAll(/^## \[([^\]]+)\]/gm),
    (match) => match[1],
  );
}

function publicRootExports(): string[] {
  const source = ts.createSourceFile(
    'src/index.ts',
    readFileSync(resolve('src/index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const exports = source.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      return [];
    }
    return statement.exportClause.elements.map((element) => element.name.text);
  });
  return [...new Set(exports)].sort();
}

describe('documentation locale parity', () => {
  it.each(publicDocuments)('provides Chinese and English %s', (document) => {
    expect(existsSync(resolve('docs', document))).toBe(true);
    expect(existsSync(resolve('docs/en', document))).toBe(true);
  });

  it('configures Chinese root and English /en/ locales', () => {
    const config = readFileSync(resolve('docs/.vitepress/config.ts'), 'utf8');

    expect(config).toContain('root: {');
    expect(config).toContain("lang: 'zh-CN'");
    expect(config).toContain('en: {');
    expect(config).toContain("lang: 'en-US'");
    expect(config).toContain("link: '/en/'");
  });

  it('excludes internal documents from the public site', () => {
    const config = readFileSync(resolve('docs/.vitepress/config.ts'), 'utf8');

    expect(config).toContain("'internal/**'");
    expect(config).toContain("'superpowers/**'");
  });

  it('lists every root package export in both API references', () => {
    const chinese = readFileSync(resolve('docs/api-reference.md'), 'utf8');
    const english = readFileSync(resolve('docs/en/api-reference.md'), 'utf8');
    const exports = publicRootExports();

    expect(exports.filter((name) => !chinese.includes(`\`${name}\``))).toEqual([]);
    expect(exports.filter((name) => !english.includes(`\`${name}\``))).toEqual([]);
  });
});

describe('release documentation parity', () => {
  it('keeps both changelogs aligned with the package version', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const englishVersions = changelogVersions('CHANGELOG.md');
    const chineseVersions = changelogVersions('CHANGELOG.zh-CN.md');

    expect(chineseVersions).toEqual(englishVersions);
    // The release workflow stamps the tag version before the changelog entry is
    // written, so during a release the manifest is one version ahead of both
    // changelogs until the release commit lands. Pending fragments make that
    // state legitimate; otherwise the two must match.
    if (englishVersions[0] !== packageJson.version) {
      const pendingFragments = readdirSync(resolve('.changes')).filter((name) =>
        name.endsWith('.json'),
      ).length;
      expect(
        packageJson.version.localeCompare(englishVersions[0] ?? '', undefined, { numeric: true }),
      ).toBeGreaterThan(0);
      expect(pendingFragments).toBeGreaterThan(0);
    }
  });

  it('ships both README and changelog locales', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        'README.md',
        'README.zh-CN.md',
        'CHANGELOG.md',
        'CHANGELOG.zh-CN.md',
      ]),
    );
  });
});
