import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    'try { m.createAgent({}); } catch (error) { console.log(error.message); }',
    'try { m.createSession({}); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(browserRootOutput, 'default', 'browser root import');
assertIncludes(browserRootOutput, 'function 1', 'browser AgentClient import');
assertIncludes(browserRootOutput, 'server-only for createAgent', 'browser root Agent facade');
assertIncludes(browserRootOutput, 'server-only for createSession', 'browser root stub');

const browserAdvancedOutput = run(process.execPath, [
  '--conditions=browser',
  '-e',
  [
    "const m = await import('@blade-ai/agent-sdk/advanced');",
    'try { m.createNodeSession({}); } catch (error) { console.log(error.message); }',
    'try { m.createServerSession({}); } catch (error) { console.log(error.message); }',
    'try { m.getBuiltinTools(); } catch (error) { console.log(error.message); }',
    'try { new m.JsonlDurableEventStore("."); } catch (error) { console.log(error.message); }',
    'try { new m.JsonlSessionRepository("."); } catch (error) { console.log(error.message); }',
    'try { new m.DockerExecutionHost(); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(
  browserAdvancedOutput,
  'server-only for createNodeSession',
  'browser advanced local Session stub',
);
assertIncludes(
  browserAdvancedOutput,
  'server-only for createServerSession',
  'browser advanced server Session stub',
);
assertIncludes(browserAdvancedOutput, 'server-only for getBuiltinTools', 'browser advanced stub');
assertIncludes(
  browserAdvancedOutput,
  'server-only for JsonlDurableEventStore',
  'browser advanced durable event store stub',
);
assertIncludes(
  browserAdvancedOutput,
  'server-only for JsonlSessionRepository',
  'browser advanced Session repository stub',
);
assertIncludes(
  browserAdvancedOutput,
  'server-only for DockerExecutionHost',
  'browser advanced execution host stub',
);

const browserInfraOutput = run(process.execPath, [
  '--conditions=browser',
  '-e',
  [
    "const m = await import('@blade-ai/agent-sdk/server/infra');",
    'try { new m.InProcessSessionExecutor({}); } catch (error) { console.log(error.message); }',
    'try { new m.AgentWorker({}); } catch (error) { console.log(error.message); }',
    'try { new m.WorkerRuntimeError(); } catch (error) { console.log(error.message); }',
  ].join(' '),
]);
assertIncludes(
  browserInfraOutput,
  'server-only for InProcessSessionExecutor',
  'browser in-process Session executor stub',
);
assertIncludes(browserInfraOutput, 'server-only for AgentWorker', 'browser AgentWorker stub');
assertIncludes(
  browserInfraOutput,
  'server-only for WorkerRuntimeError',
  'browser worker runtime error stub',
);

const subpathOutput = run(process.execPath, [
  '-e',
  [
    "const root = await import('@blade-ai/agent-sdk');",
    "const browser = await import('@blade-ai/agent-sdk/browser');",
    "const advanced = await import('@blade-ai/agent-sdk/advanced');",
    "const infra = await import('@blade-ai/agent-sdk/server/infra');",
    "console.log('root', typeof root.createAgent, typeof root.defineTool, typeof root.composeMiddleware, root.PROVIDER_TYPES.length);",
    "console.log('browser', typeof browser.AgentClient, typeof browser.AgentResponse, browser.AGENT_PROTOCOL_VERSION);",
    "console.log('advanced', typeof advanced.createSession, typeof advanced.createServerSession, typeof advanced.getBuiltinTools, typeof advanced.JsonlDurableEventStore, typeof advanced.DockerExecutionHost, typeof advanced.EffectDispatcher, typeof advanced.SdkSessionRunner);",
    "console.log('infra', typeof infra.AgentServer, typeof infra.AgentWorker, typeof infra.InMemoryAgentServerStore, typeof infra.RuntimeStoreError, typeof infra.assertRuntimeStoreConformance, infra.RUNTIME_SESSION_STATES.length);",
    "console.log('boundaries', 'createAgent' in infra, 'createSession' in infra, 'EffectDispatcher' in infra, 'PostgresRuntimeStore' in infra, 'OpenTelemetryAgentServerTelemetry' in infra);",
  ].join(' '),
]);
assertIncludes(subpathOutput, 'root function function function 6', 'root entrypoint');
assertIncludes(subpathOutput, 'browser function function 1', 'browser entrypoint');
assertIncludes(
  subpathOutput,
  'advanced function function function function function function function',
  'advanced entrypoint',
);
assertIncludes(
  subpathOutput,
  'infra function function function function function 8',
  'server infrastructure entrypoint',
);
assertIncludes(
  subpathOutput,
  'boundaries false false false false false',
  'canonical entrypoint boundaries',
);

const profileOutput = run(process.execPath, [
  '-e',
  [
    "const root = await import('@blade-ai/agent-sdk');",
    "const infra = await import('@blade-ai/agent-sdk/server/infra');",
    "const advanced = await import('@blade-ai/agent-sdk/advanced');",
    "console.log(typeof root.createAgent, root.createAgent === advanced.createAgent, root.createSession === advanced.createServerSession, advanced.createSession === advanced.createServerSession, 'createAgent' in infra, 'createSession' in infra, 'getBuiltinTools' in root, 'getBuiltinTools' in advanced);",
  ].join(' '),
]);
assertIncludes(
  profileOutput,
  'function true true false false false false true',
  'runtime profile boundaries',
);

const compatibilityOutput = run(process.execPath, [
  '-e',
  [
    "const root = await import('@blade-ai/agent-sdk');",
    "const core = await import('@blade-ai/agent-sdk/core');",
    "const model = await import('@blade-ai/agent-sdk/model');",
    "const middleware = await import('@blade-ai/agent-sdk/middleware');",
    "const tools = await import('@blade-ai/agent-sdk/tools');",
    "const browser = await import('@blade-ai/agent-sdk/browser');",
    "const protocol = await import('@blade-ai/agent-sdk/protocol');",
    "const advanced = await import('@blade-ai/agent-sdk/advanced');",
    "const node = await import('@blade-ai/agent-sdk/node');",
    "const session = await import('@blade-ai/agent-sdk/session');",
    "const infra = await import('@blade-ai/agent-sdk/server/infra');",
    "const server = await import('@blade-ai/agent-sdk/server');",
    "const postgres = await import('@blade-ai/agent-sdk/server/postgres');",
    "const otel = await import('@blade-ai/agent-sdk/server/otel');",
    "const testing = await import('@blade-ai/agent-sdk/server/testing');",
    "console.log(core.PermissionMode === root.PermissionMode, model.PROVIDER_TYPES === root.PROVIDER_TYPES, middleware.composeMiddleware === root.composeMiddleware, tools.defineTool === root.defineTool, protocol.AGENT_PROTOCOL_VERSION === browser.AGENT_PROTOCOL_VERSION, node.createSession === advanced.createSession, session.createSession === advanced.createServerSession, server.AgentServer === infra.AgentServer, typeof postgres.PostgresRuntimeStore, typeof otel.OpenTelemetryAgentServerTelemetry, testing.assertRuntimeStoreConformance === infra.assertRuntimeStoreConformance);",
  ].join(' '),
]);
assertIncludes(
  compatibilityOutput,
  'true true true true true true true true function function true',
  'deprecated compatibility aliases',
);

verifyBrowserSafeDist('dist/browser/index.js');
verifyBrowserSafeDist('dist/browser/server-only-stub.js');
verifyBrowserSafeDist('dist/core/index.js');
verifyBrowserSafeDist('dist/middleware/index.js');
verifyBrowserSafeDist('dist/model/index.js');
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

// The runtime version is inlined at build time, so the bundle must carry the
// version the manifest declares. A build that ran before a version stamp would
// otherwise ship the previous version into the MCP handshake.
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const distRoot = join(repoRoot, 'dist');
if (!existsSync(distRoot)) {
  throw new Error('dist/ is missing; build before verifying the entry points');
}
// The manifest is inlined into a shared chunk, so every emitted file is scanned.
const builtFiles = readdirSync(distRoot, { withFileTypes: true }).flatMap((entry) => {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    return [join(distRoot, entry.name)];
  }
  if (entry.isDirectory()) {
    return readdirSync(join(distRoot, entry.name))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(distRoot, entry.name, name));
  }
  return [];
});
if (builtFiles.length === 0) {
  throw new Error('No built entry bundle was found under dist/');
}
const carriesVersion = builtFiles.some((file) => {
  const source = readFileSync(file, 'utf8');
  return source.includes(`version:"${manifest.version}"`)
    || source.includes(`"version":"${manifest.version}"`);
});
if (!carriesVersion) {
  throw new Error(
    `Built bundles do not carry the manifest version ${manifest.version}; `
    + 'rebuild after changing the version',
  );
}

console.log('entrypoint verification passed');
