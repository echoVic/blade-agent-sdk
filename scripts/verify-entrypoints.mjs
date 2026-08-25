import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const disallowedRuntimeImports = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
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
  const absolutePath = resolve(repoRoot, entryPath);
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
    'console.log(m.PermissionMode.DEFAULT, typeof m.AgentClient, m.AGENT_PROTOCOL_VERSION);',
    'try { m.createSession({}); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(browserRootOutput, 'default', 'browser root import');
assertIncludes(browserRootOutput, 'function 1', 'browser AgentClient import');
assertIncludes(browserRootOutput, 'server-only for createSession', 'browser root stub');

const browserNodeOutput = run(process.execPath, [
  '--conditions=browser',
  '-e',
  [
    "const m = await import('@blade-ai/agent-sdk/node');",
    'try { m.getBuiltinTools(); } catch (error) { console.log(error.message); }',
    'try { new m.JsonlDurableEventStore("."); } catch (error) { console.log(error.message); }',
    'try { new m.JsonlSessionRepository("."); } catch (error) { console.log(error.message); }',
    'try { new m.DockerExecutionHost(); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(browserNodeOutput, 'server-only for getBuiltinTools', 'browser Node stub');
assertIncludes(
  browserNodeOutput,
  'server-only for JsonlDurableEventStore',
  'browser Node durable event store stub',
);
assertIncludes(
  browserNodeOutput,
  'server-only for JsonlSessionRepository',
  'browser Node Session repository stub',
);
assertIncludes(
  browserNodeOutput,
  'server-only for DockerExecutionHost',
  'browser Docker execution host stub',
);

const browserServerOutput = run(process.execPath, [
  '--conditions=browser',
  '-e',
  [
    "const m = await import('@blade-ai/agent-sdk/server');",
    'try { new m.InProcessSessionExecutor({}); } catch (error) { console.log(error.message); }',
    'try { new m.PostgresRuntimeStore({}); } catch (error) { console.log(error.message); }',
    'try { new m.EphemeralCredentialBroker({}); } catch (error) { console.log(error.message); }',
    'try { new m.ExecutionHostError(); } catch (error) { console.log(error.message); }',
    'try { new m.WorkerRuntimeError(); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(
  browserServerOutput,
  'server-only for InProcessSessionExecutor',
  'browser in-process Session executor stub',
);
assertIncludes(
  browserServerOutput,
  'server-only for PostgresRuntimeStore',
  'browser PostgreSQL runtime Store stub',
);
assertIncludes(
  browserServerOutput,
  'server-only for EphemeralCredentialBroker',
  'browser credential broker stub',
);
assertIncludes(
  browserServerOutput,
  'server-only for ExecutionHostError',
  'browser execution host error stub',
);
assertIncludes(
  browserServerOutput,
  'server-only for WorkerRuntimeError',
  'browser worker runtime error stub',
);

const subpathOutput = run(process.execPath, [
  '-e',
  [
    "const core = await import('@blade-ai/agent-sdk/core');",
    "const browser = await import('@blade-ai/agent-sdk/browser');",
    "const server = await import('@blade-ai/agent-sdk/server');",
    "const postgres = await import('@blade-ai/agent-sdk/server/postgres');",
    "const testing = await import('@blade-ai/agent-sdk/server/testing');",
    "const tools = await import('@blade-ai/agent-sdk/tools');",
    "const node = await import('@blade-ai/agent-sdk/node');",
    "const protocol = await import('@blade-ai/agent-sdk/protocol');",
    "const middleware = await import('@blade-ai/agent-sdk/middleware');",
    "console.log(core.PermissionMode.DEFAULT, core.DurableEventType.REQUEST_ACCEPTED, core.projectDurableSession([]).status, typeof core.DurableSessionJournal.open, typeof core.DurableSessionRecoveryCoordinator.open, typeof core.DurableEventSubscription.open, browser.PermissionMode.DEFAULT, typeof browser.AgentClient, typeof server.createSession, typeof server.AgentServer, typeof server.InProcessSessionExecutor, typeof postgres.PostgresRuntimeStore, typeof testing.assertRuntimeStoreConformance, typeof tools.defineTool, typeof node.createSession, typeof node.getBuiltinTools, typeof node.JsonlDurableEventStore, typeof node.JsonlSessionRepository, protocol.AGENT_PROTOCOL_VERSION, typeof middleware.composeMiddleware);",
    "console.log(postgres.RUNTIME_SESSION_STATES.join(','), typeof postgres.effectLease, typeof server.WorkerRuntimeError);",
    "console.log(typeof server.EphemeralCredentialBroker, typeof server.ExecutionHostError, typeof node.DockerExecutionHost, core.ExecutionId('execution-1'), core.ExecutionCheckpointId('checkpoint-1'), core.CredentialLeaseId('credential-1'));",
  ].join(' '),
]);
assertIncludes(
  subpathOutput,
  'default request_accepted empty function function function default function function function function function function function function function function function 1 function',
  'subpath imports',
);
assertIncludes(
  subpathOutput,
  'queued,provisioning,running,waiting_approval,suspended,completed,failed function function',
  'worker runtime exports',
);
assertIncludes(
  subpathOutput,
  'function function function execution-1 checkpoint-1 credential-1',
  'execution host exports',
);

const profileOutput = run(process.execPath, [
  '-e',
  [
    "const root = await import('@blade-ai/agent-sdk');",
    "const server = await import('@blade-ai/agent-sdk/server');",
    "const node = await import('@blade-ai/agent-sdk/node');",
    "console.log(root.createSession === server.createSession, node.createSession === server.createSession, 'getBuiltinTools' in root, 'getBuiltinTools' in node);",
  ].join(' '),
]);
assertIncludes(profileOutput, 'true false false true', 'runtime profile boundaries');

verifyBrowserSafeDist('dist/browser/index.js');
verifyBrowserSafeDist('dist/browser/server-only-stub.js');
verifyBrowserSafeDist('dist/core/index.js');
verifyBrowserSafeDist('dist/middleware/index.js');
verifyBrowserSafeDist('dist/protocol/index.js');
verifyBrowserSafeDist('dist/server/testing/index.js');
verifyBrowserSafeDist('dist/tools/index.js');

const tempDir = mkdtempSync(join(repoRoot, '.tmp-entrypoints-'));
try {
  const entry = join(tempDir, 'client-entry.ts');
  const output = join(tempDir, 'bundle.js');
  writeFileSync(
    entry,
    [
      "import { createSession, PermissionMode } from '@blade-ai/agent-sdk';",
      "console.log(PermissionMode.DEFAULT, typeof createSession);",
    ].join('\n'),
    'utf8',
  );

  run('pnpm', [
    'exec',
    'esbuild',
    entry,
    '--bundle',
    '--platform=browser',
    '--conditions=browser',
    '--format=esm',
    `--outfile=${output}`,
  ]);
  assertNoDisallowedImports(output);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('entrypoint verification passed');
