import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const publicDocuments = [
  'index.md',
  'blade-agent-sdk.md',
  'providers.md',
  'session.md',
  'server-runtime.md',
  'durable-events.md',
  'tools.md',
  'permissions.md',
  'hooks.md',
  'mcp.md',
  'sandbox.md',
  'agents.md',
  'skills.md',
  'recipes.md',
  'api-reference.md',
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
      !ts.isExportDeclaration(statement)
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
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

    expect(config).toContain("root: {");
    expect(config).toContain("lang: 'zh-CN'");
    expect(config).toContain("en: {");
    expect(config).toContain("lang: 'en-US'");
    expect(config).toContain("link: '/en/'");
  });

  it('excludes internal research and audit documents', () => {
    const config = readFileSync(resolve('docs/.vitepress/config.ts'), 'utf8');

    expect(config).toContain("'deepseek-api-research.md'");
    expect(config).toContain("'simplification-audit.md'");
    expect(config).toContain("'superpowers/**'");
  });

  it('lists every root package export in both API references', () => {
    const chinese = readFileSync(resolve('docs/api-reference.md'), 'utf8');
    const english = readFileSync(resolve('docs/en/api-reference.md'), 'utf8');
    const exports = publicRootExports();

    expect(exports.filter((name) => !chinese.includes(`\`${name}\``)))
      .toEqual([]);
    expect(exports.filter((name) => !english.includes(`\`${name}\``)))
      .toEqual([]);
  });
});

describe('release documentation parity', () => {
  it('keeps both changelogs aligned with the package version', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const englishVersions = changelogVersions('CHANGELOG.md');
    const chineseVersions = changelogVersions('CHANGELOG.zh-CN.md');

    expect(chineseVersions).toEqual(englishVersions);
    expect(englishVersions[0]).toBe(packageJson.version);
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
