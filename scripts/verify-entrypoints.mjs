import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = existsSync(join(repoRoot, 'packages/agent-sdk/package.json'))
  ? join(repoRoot, 'packages/agent-sdk')
  : repoRoot;
const disallowedRuntimeImports = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
  return result.stdout.trim();
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include expected text: ${expected}\nActual:\n${text}`);
  }
}

function assertNoDisallowedImports(filePath) {
  const source = readFileSync(filePath, 'utf8');
  for (const pattern of disallowedRuntimeImports) {
    if (source.includes(pattern)) {
      throw new Error(`${filePath} contains browser-disallowed import marker: ${pattern}`);
    }
  }
}

function collectStaticImports(entryPath, seen = new Set()) {
  const absolutePath = resolve(packageRoot, entryPath);
  if (seen.has(absolutePath)) return seen;
  seen.add(absolutePath);

  const source = readFileSync(absolutePath, 'utf8');
  const importPattern = /(?:from|import)\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const child = resolve(dirname(absolutePath), specifier);
    if (existsSync(child)) {
      collectStaticImports(child, seen);
    }
  }
  return seen;
}

function verifyBrowserSafeDist(entryPath) {
  for (const filePath of collectStaticImports(entryPath)) {
    assertNoDisallowedImports(filePath);
  }
}

const browserRootOutput = run(process.execPath, [
  '--conditions=browser',
  '-e',
  [
    "const m = await import('@blade-ai/agent-sdk');",
    'console.log(m.PermissionMode.DEFAULT);',
    'try { m.createSession({}); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(browserRootOutput, 'default', 'browser root import');
assertIncludes(browserRootOutput, 'server-only for createSession', 'browser root stub');

const subpathOutput = run(process.execPath, [
  '-e',
  [
    "const core = await import('@blade-ai/agent-sdk/core');",
    "const browser = await import('@blade-ai/agent-sdk/browser');",
    "const server = await import('@blade-ai/agent-sdk/server');",
    "const tools = await import('@blade-ai/agent-sdk/tools');",
    "const local = await import('@blade-ai/agent-sdk/local');",
    "console.log(core.PermissionMode.DEFAULT, browser.PermissionMode.DEFAULT, typeof server.createSession, typeof tools.defineTool, typeof local.getBuiltinTools);",
  ].join(' '),
]);
assertIncludes(subpathOutput, 'default default function function function', 'subpath imports');

verifyBrowserSafeDist('dist/browser/index.js');
verifyBrowserSafeDist('dist/browser/server-only-stub.js');
verifyBrowserSafeDist('dist/core/index.js');
verifyBrowserSafeDist('dist/tools/index.js');

const tempDir = mkdtempSync(join(packageRoot, '.tmp-entrypoints-'));
try {
  const entry = join(tempDir, 'client-entry.ts');
  const output = join(tempDir, 'bundle.js');
  writeFileSync(
    entry,
    [
      "import { createSession, PermissionMode } from '@blade-ai/agent-sdk';",
      "import { createSession as createBrowserSession, PermissionMode as BrowserPermissionMode, StreamMessageType as BrowserStreamMessageType } from '@blade-ai/agent-sdk/browser';",
      "import { StreamMessageType } from '@blade-ai/agent-sdk/core';",
      "import { ToolKind } from '@blade-ai/agent-sdk/tools';",
      "import { resumeSession } from '@blade-ai/agent-sdk/session';",
      "import { createSession as createInternalSession } from '@blade-ai/agent-sdk/session/internal';",
      "import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';",
      "import { getBuiltinTools } from '@blade-ai/agent-sdk/local';",
      "console.log(PermissionMode.DEFAULT, BrowserPermissionMode.DEFAULT, StreamMessageType.CONTENT, BrowserStreamMessageType.CONTENT, ToolKind.ReadOnly, typeof createSession);",
      "try { createSession({}); } catch (error) { console.log(`server-only for bundled createSession: ${error.message}`); }",
      "try { createBrowserSession({}); } catch (error) { console.log(`server-only for bundled browser createSession: ${error.message}`); }",
      "try { resumeSession('session-id'); } catch (error) { console.log(`server-only for bundled resumeSession: ${error.message}`); }",
      "try { createInternalSession({}); } catch (error) { console.log(`server-only for bundled internal createSession: ${error.message}`); }",
      "try { createServerSession({}); } catch (error) { console.log(`server-only for bundled server createSession: ${error.message}`); }",
      "try { getBuiltinTools(); } catch (error) { console.log(`server-only for bundled getBuiltinTools: ${error.message}`); }",
    ].join('\n'),
    'utf8',
  );

  await bundleWithEsbuildRetry({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    conditions: ['browser'],
    format: 'esm',
    outfile: output,
    absWorkingDir: repoRoot,
    logLevel: 'silent',
  });
  assertNoDisallowedImports(output);
  const browserBundleOutput = run(process.execPath, [output], { cwd: packageRoot });
  assertIncludes(browserBundleOutput, 'default default content content readonly function', 'browser bundle root import');
  assertIncludes(browserBundleOutput, 'server-only for bundled createSession', 'browser bundle root stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled browser createSession', 'browser bundle browser stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled resumeSession', 'browser bundle session stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled internal createSession', 'browser bundle internal session stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled server createSession', 'browser bundle server stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled getBuiltinTools', 'browser bundle local stub');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('entrypoint verification passed');
