import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const root = resolve('src');
const source = (path: string) => readFileSync(resolve(path), 'utf8');

function productionFiles(directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionFiles(path);
    }
    return extname(entry.name) === '.ts' && !/\.(?:test|spec)\.ts$/.test(path) ? [path] : [];
  });
}

describe('final source architecture', () => {
  test('uses one provider table and shared model adapters', () => {
    const service = source('src/services/VercelAIModelService.ts');
    expect(source('src/services/modelProvider.ts')).toContain('PROVIDER_FACTORIES');
    expect(source('src/services/modelAdapter.ts')).toContain('prepareModelRequest');
    expect(service).toContain('./modelProvider.js');
    expect(service).toContain('./modelAdapter.js');
  });

  test('splits Docker process, policy, and workspace ownership', () => {
    const host = source('src/execution/DockerExecutionHost.ts');
    for (const file of [
      'src/execution/DockerProcessRunner.ts',
      'src/execution/DockerExecutionPolicy.ts',
      'src/execution/DockerWorkspace.ts',
    ]) {
      expect(existsSync(resolve(file)), `${file} must exist`).toBe(true);
    }
    expect(host).toContain('./DockerProcessRunner.js');
    expect(host).toContain('./DockerExecutionPolicy.js');
    expect(host).toContain('./DockerWorkspace.js');
  });

  test('keeps production files and functions within the architecture bounds', () => {
    const oversizedFiles: string[] = [];
    const oversizedFunctions: string[] = [];
    for (const file of productionFiles()) {
      const text = source(file);
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const lines = text.split('\n').length;
      if (lines > 900) oversizedFiles.push(`${relative(root, file)}:${lines}`);
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && 'body' in node && node.body) {
          const start =
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
          if (end - start + 1 > 150) {
            const name =
              'name' in node && node.name && typeof node.name === 'object'
                ? (node.name as ts.Node).getText(sourceFile)
                : '<anonymous>';
            oversizedFunctions.push(`${relative(root, file)}:${start}:${name}:${end - start + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(oversizedFiles).toEqual([]);
    expect(oversizedFunctions).toEqual([]);
  });

  test('does not ship unused runtime dependencies', () => {
    const dependencies = (
      JSON.parse(source('package.json')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    for (const dependency of ['chalk', 'lodash-es', 'semver', 'zustand']) {
      expect(dependencies, dependency).not.toHaveProperty(dependency);
    }
  });
});
