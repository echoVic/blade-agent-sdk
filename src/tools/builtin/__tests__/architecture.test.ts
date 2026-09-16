import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const builtinRoot = resolve('src/tools/builtin');
const source = (path: string) => readFileSync(resolve(builtinRoot, path), 'utf8');

function productionFiles(directory = builtinRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionFiles(path);
    }
    return extname(entry.name) === '.ts' ? [path] : [];
  });
}

describe('built-in tool ownership', () => {
  test.each([
    [
      'file/operationCore.ts',
      [
        ['file/read.ts', './operationCore.js'],
        ['file/write.ts', './operationCore.js'],
        ['file/edit.ts', './operationCore.js'],
        ['notebook/notebookEdit.ts', '../file/operationCore.js'],
      ],
    ],
    [
      'search/searchRunner.ts',
      [
        ['search/glob.ts', './searchRunner.js'],
        ['search/grep.ts', './searchRunner.js'],
      ],
    ],
    [
      'web/webRequest.ts',
      [
        ['web/webFetch.ts', './webRequest.js'],
        ['web/webSearch.ts', './webRequest.js'],
      ],
    ],
    ['task/taskCrud.ts', [['task/index.ts', './taskCrud.js']]],
  ] as const)('%s is the shared owner', (owner, consumers) => {
    expect(existsSync(resolve(builtinRoot, owner)), `${owner} must exist`).toBe(true);
    for (const [consumer, importPath] of consumers) {
      expect(source(consumer), consumer).toContain(importPath);
    }
  });

  test('task CRUD and web search have one implementation each', () => {
    for (const obsolete of [
      'task/taskCreate.ts',
      'task/taskGet.ts',
      'task/taskList.ts',
      'task/taskUpdate.ts',
      'web/SearchCache.ts',
      'web/searchProviders.ts',
    ]) {
      expect(existsSync(resolve(builtinRoot, obsolete)), obsolete).toBe(false);
    }
  });

  test('keeps every built-in production file at or below 700 lines', () => {
    for (const file of productionFiles()) {
      expect(
        source(file.slice(builtinRoot.length + 1)).split('\n').length,
        file,
      ).toBeLessThanOrEqual(700);
    }
  });

  test.each([
    'task/task.ts',
    'task/taskOutput.ts',
  ])('keeps %s orchestration below 300 lines', (file) => {
    expect(source(file).split('\n').length, file).toBeLessThanOrEqual(300);
  });
});
