import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentSdkCoreDeclarationBrowserSafeRules,
  agentSdkEagerLegacySessionRuntimeClosureRules,
  agentSdkLocalAdapterBoundaryRules,
  agentSdkPermissionDeclarationBoundaryRules,
  agentSdkRootDeclarationEntryOwnershipRules,
  agentSdkRootPublicDeclarationBoundaryRules,
  agentSdkRootSubagentCompatibilityBoundaryRules,
  agentSdkServerFacadeBoundaryRules,
  agentSdkSessionConfigDeclarationBoundaryRules,
  agentSdkSessionEntrySessionBoundaryRules,
  agentSdkSessionFactoryDeclarationBoundaryRules,
  agentSdkSessionPublicDeclarationBoundaryRules,
  agentSdkSessionStoreDeclarationBoundaryRules,
  agentSdkToolsEntryBoundaryRules,
  toLocalForbiddenDeclarationRules,
} from './agent-sdk-boundary-rules.mjs';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';
import {
  createAgentPublicTypeImportLines,
  createAiPublicTypeImportLines,
  createSdkPublicTypeImportLines,
} from './public-type-contracts.mjs';

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

function assertNoRuntimeExport(module, name) {
  if (Object.hasOwn(module, name)) {
    throw new Error(`Unexpected runtime export ${name}`);
  }
}

function collectDeclarationExports(source) {
  const strippedSource = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
  const exportNames = new Set();
  const namedExportPattern = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["']/g;

  for (const match of strippedSource.matchAll(namedExportPattern)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const withoutTypeModifier = specifier.replace(/^type\s+/, '').trim();
      const aliased = withoutTypeModifier.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const exportedName = aliased?.[1] ?? withoutTypeModifier.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (exportedName) {
        exportNames.add(exportedName);
      }
    }
  }

  return [...exportNames].sort();
}

function assertDeclarationExportParity(leftSource, rightSource) {
  const leftExports = collectDeclarationExports(leftSource);
  const rightExports = collectDeclarationExports(rightSource);
  const missingFromRight = leftExports.filter((name) => !rightExports.includes(name));
  const extraInRight = rightExports.filter((name) => !leftExports.includes(name));

  if (missingFromRight.length > 0 || extraInRight.length > 0) {
    throw new Error([
      'Declaration export mismatch between local root and local server',
      missingFromRight.length > 0 ? `declarations missing from local server: ${missingFromRight.join(', ')}` : undefined,
      extraInRight.length > 0 ? `declarations extra in local server: ${extraInRight.join(', ')}` : undefined,
    ].filter(Boolean).join('; '));
  }

  return [leftExports.length, rightExports.length];
}

function assertNoForbiddenDeclarationSymbols(source, rules, label) {
  for (const rule of rules) {
    if (source.includes(rule.forbidden)) {
      throw new Error(`${label}: ${rule.message}`);
    }
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

function verifyLocalNoEagerLegacySessionRuntime() {
  for (const filePath of collectStaticImports('dist/session/index.js')) {
    const source = readFileSync(filePath, 'utf8');
    for (const rule of agentSdkEagerLegacySessionRuntimeClosureRules) {
      if (source.includes(rule.forbidden)) {
        throw new Error(
          `${filePath}: public session entry eagerly includes legacy root session runtime marker ${rule.forbidden}`,
        );
      }
    }
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

const browserRootModule = await import(pathToFileURL(join(packageRoot, 'dist/browser/index.js')).href);
assertNoRuntimeExport(browserRootModule, 'getBuiltinTools');
assertNoRuntimeExport(browserRootModule, 'createSdkMcpServer');
assertNoRuntimeExport(browserRootModule, 'FileSystemMemoryStore');
assertNoRuntimeExport(browserRootModule, 'MemoryManager');
assertNoRuntimeExport(browserRootModule, 'createMemoryReadTool');
assertNoRuntimeExport(browserRootModule, 'createMemoryWriteTool');
assertNoRuntimeExport(browserRootModule, 'tool');
console.log('local browser root local-only export boundary passed');

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

const rootServerParityOutput = run(process.execPath, [
  '-e',
  [
    "const root = await import('@blade-ai/agent-sdk');",
    "const server = await import('@blade-ai/agent-sdk/server');",
    'const rootKeys = Object.keys(root).sort();',
    'const serverKeys = Object.keys(server).sort();',
    'const missingFromServer = rootKeys.filter((key) => !serverKeys.includes(key));',
    'const extraInServer = serverKeys.filter((key) => !rootKeys.includes(key));',
    'if (missingFromServer.length > 0 || extraInServer.length > 0) {',
    '  throw new Error([',
    "    'Runtime export mismatch between local root and local server',",
    "    missingFromServer.length > 0 ? `missing from local server: ${missingFromServer.join(', ')}` : undefined,",
    "    extraInServer.length > 0 ? `extra in local server: ${extraInServer.join(', ')}` : undefined,",
    '  ].filter(Boolean).join(\'; \'));',
    '}',
    "console.log('local root server runtime export parity', rootKeys.length, serverKeys.length);",
  ].join(' '),
]);
assertIncludes(
  rootServerParityOutput,
  'local root server runtime export parity',
  'local root/server runtime export parity',
);

const [rootDeclarationCount, serverDeclarationCount] = assertDeclarationExportParity(
  readFileSync(join(packageRoot, 'dist/index.d.ts'), 'utf8'),
  readFileSync(join(packageRoot, 'dist/server/index.d.ts'), 'utf8'),
);
console.log('local root server declaration export parity', rootDeclarationCount, serverDeclarationCount);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/core/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkCoreDeclarationBrowserSafeRules),
  'local core declaration browser-safe boundary',
);
console.log('local core declaration browser-safe boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkRootPublicDeclarationBoundaryRules),
  'local root declaration public boundary',
);
console.log('local root declaration public boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkRootDeclarationEntryOwnershipRules),
  'local root declaration entry ownership boundary',
);
console.log('local root declaration entry ownership boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/index.js'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkRootSubagentCompatibilityBoundaryRules.filter((rule) => rule.file === 'dist/index.js'),
  ),
  'local root subagent runtime boundary',
);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkRootSubagentCompatibilityBoundaryRules.filter((rule) => rule.file === 'dist/index.d.ts'),
  ),
  'local root subagent declaration boundary',
);
console.log('local root subagent compatibility boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/types.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkSessionPublicDeclarationBoundaryRules),
  'local session declaration public boundary',
);
console.log('local session declaration public boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/index.js'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkSessionEntrySessionBoundaryRules.filter((rule) => rule.file === 'dist/session/index.js'),
  ),
  'local session runtime entry boundary',
);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkSessionEntrySessionBoundaryRules.filter((rule) => rule.file === 'dist/session/index.d.ts'),
  ),
  'local session declaration entry boundary',
);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/Session.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkSessionEntrySessionBoundaryRules.filter((rule) => rule.file === 'dist/session/Session.d.ts'),
  ),
  'local session declaration Session boundary',
);
verifyLocalNoEagerLegacySessionRuntime();
console.log('local session entry Session boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/factory.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkSessionFactoryDeclarationBoundaryRules),
  'local session factory declaration boundary',
);
console.log('local session factory declaration boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/config.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkSessionConfigDeclarationBoundaryRules),
  'local session config declaration boundary',
);
console.log('local session config declaration boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/session/store.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkSessionStoreDeclarationBoundaryRules),
  'local session store declaration boundary',
);
console.log('local session store declaration boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/tools/index.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkToolsEntryBoundaryRules.filter((rule) => rule.file === 'dist/tools/index.d.ts'),
  ),
  'local tools declaration entry boundary',
);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/tools/index.js'), 'utf8'),
  toLocalForbiddenDeclarationRules(
    agentSdkToolsEntryBoundaryRules.filter((rule) => rule.file === 'dist/tools/index.js'),
  ),
  'local tools runtime entry boundary',
);
console.log('local tools entry boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/local/index.d.ts'), 'utf8'),
  agentSdkLocalAdapterBoundaryRules.filter((rule) => rule.file === 'dist/local/index.d.ts'),
  'local adapter declaration boundary',
);

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/local/index.js'), 'utf8'),
  agentSdkLocalAdapterBoundaryRules.filter((rule) => rule.file === 'dist/local/index.js'),
  'local adapter runtime boundary',
);
console.log('local adapter entry boundary passed');

assertNoForbiddenDeclarationSymbols(
  readFileSync(join(packageRoot, 'dist/types/permissions.d.ts'), 'utf8'),
  toLocalForbiddenDeclarationRules(agentSdkPermissionDeclarationBoundaryRules),
  'local permission declaration boundary',
);
console.log('local permission declaration boundary passed');

for (const rule of agentSdkServerFacadeBoundaryRules) {
  assertNoForbiddenDeclarationSymbols(
    readFileSync(join(packageRoot, rule.file), 'utf8'),
    toLocalForbiddenDeclarationRules([rule]),
    `local ${rule.boundary}`,
  );
}
console.log('local server facade boundary passed');

verifyBrowserSafeDist('dist/browser/index.js');
verifyBrowserSafeDist('dist/browser/server-only-stub.js');
verifyBrowserSafeDist('dist/core/index.js');
verifyBrowserSafeDist('dist/errors/index.js');
verifyBrowserSafeDist('dist/tools/index.js');

const tempDir = mkdtempSync(join(packageRoot, '.tmp-entrypoints-'));
try {
  const entry = join(tempDir, 'client-entry.ts');
  const output = join(tempDir, 'bundle.js');
  const aiEntry = join(tempDir, 'ai-entry.mjs');
  const metadataEntry = join(tempDir, 'metadata-entry.mjs');
  const declarationEntry = join(tempDir, 'declaration-entry.ts');
  const declarationTsconfig = join(tempDir, 'declaration-tsconfig.json');
  const agentEntry = join(tempDir, 'agent-client-entry.ts');
  const agentOutput = join(tempDir, 'agent-bundle.js');
  writeFileSync(
    entry,
    [
      "import { createSession, PermissionMode } from '@blade-ai/agent-sdk';",
      "import { createSession as createBrowserSession, PermissionMode as BrowserPermissionMode, StreamMessageType as BrowserStreamMessageType } from '@blade-ai/agent-sdk/browser';",
      "import { StreamMessageType } from '@blade-ai/agent-sdk/core';",
      "import { ConfigError, SdkError } from '@blade-ai/agent-sdk/errors';",
      "import { ToolCatalog, ToolKind, defineTool } from '@blade-ai/agent-sdk/tools';",
      "import { resumeSession } from '@blade-ai/agent-sdk/session';",
      "import { createSession as createInternalSession } from '@blade-ai/agent-sdk/session/internal';",
      "import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';",
      "import { getBuiltinTools } from '@blade-ai/agent-sdk/local';",
      "const sdkError = new ConfigError('browser-safe sdk error');",
      "const browserSafeTool = defineTool({",
      "  name: 'browser_tool',",
      "  description: 'Browser-safe tool contract smoke',",
      "  kind: ToolKind.ReadOnly,",
      "  parameters: { type: 'object', properties: {}, required: [] },",
      "  async execute() { return 'ok'; },",
      "});",
      "const browserSafeCatalog = new ToolCatalog();",
      "console.log(PermissionMode.DEFAULT, BrowserPermissionMode.DEFAULT, StreamMessageType.CONTENT, BrowserStreamMessageType.CONTENT, ToolKind.ReadOnly, typeof createSession);",
      "console.log('browser-safe sdk error', sdkError instanceof SdkError, sdkError.code);",
      "console.log('browser-safe sdk tool', browserSafeTool.name, browserSafeTool.kind, browserSafeCatalog.getAll().length);",
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
  assertIncludes(browserBundleOutput, 'browser-safe sdk error true CONFIG_ERROR', 'browser bundle errors import');
  assertIncludes(browserBundleOutput, 'browser-safe sdk tool browser_tool readonly 0', 'browser bundle tools import');
  assertIncludes(browserBundleOutput, 'server-only for bundled createSession', 'browser bundle root stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled browser createSession', 'browser bundle browser stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled resumeSession', 'browser bundle session stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled internal createSession', 'browser bundle internal session stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled server createSession', 'browser bundle server stub');
  assertIncludes(browserBundleOutput, 'server-only for bundled getBuiltinTools', 'browser bundle local stub');

  writeFileSync(
    aiEntry,
    [
      "import * as ai from '@blade-ai/ai';",
      "import * as aiChat from '@blade-ai/ai/chat';",
      "import * as aiModel from '@blade-ai/ai/model';",
      "import * as aiDeepseek from '@blade-ai/ai/deepseek';",
      "import * as aiOpenAICompatible from '@blade-ai/ai/providers/openai-compatible';",
      "import * as aiVercel from '@blade-ai/ai/providers/vercel';",
      "import * as aiRetry from '@blade-ai/ai/retry';",
      "console.log('local ai provider runtime exports', typeof ai.createOpenAICompatibleModelPort, typeof aiDeepseek.normalizeDeepSeekModel, typeof aiOpenAICompatible.createOpenAICompatibleModelPort, typeof aiVercel.createVercelModelPort, typeof aiRetry.withRetry);",
      "console.log('local ai retry runtime export', typeof aiRetry.DEFAULT_RETRY_CONFIG);",
      "console.log('local ai chat runtime empty', Object.keys(aiChat).length);",
      "console.log('local ai model runtime empty', Object.keys(aiModel).length);",
    ].join('\n'),
    'utf8',
  );
  const aiOutput = run(process.execPath, [aiEntry], { cwd: packageRoot });
  assertIncludes(
    aiOutput,
    'local ai provider runtime exports function function function function function',
    'local ai provider runtime exports',
  );
  assertIncludes(aiOutput, 'local ai retry runtime export object', 'local ai retry runtime export');
  assertIncludes(aiOutput, 'local ai chat runtime empty 0', 'local ai chat runtime empty');
  assertIncludes(aiOutput, 'local ai model runtime empty 0', 'local ai model runtime empty');

  writeFileSync(
    metadataEntry,
    [
      "import aiPackage from '@blade-ai/ai/package.json' with { type: 'json' };",
      "import agentPackage from '@blade-ai/agent/package.json' with { type: 'json' };",
      "import agentSdkPackage from '@blade-ai/agent-sdk/package.json' with { type: 'json' };",
      "console.log('local package metadata', aiPackage.name, agentPackage.name, agentSdkPackage.name);",
    ].join('\n'),
    'utf8',
  );
  const metadataOutput = run(process.execPath, [metadataEntry], { cwd: packageRoot });
  assertIncludes(
    metadataOutput,
    'local package metadata @blade-ai/ai @blade-ai/agent @blade-ai/agent-sdk',
    'local package metadata subpath imports',
  );

  writeFileSync(
    declarationEntry,
    [
      ...createAiPublicTypeImportLines('localDeclaration'),
      ...createAgentPublicTypeImportLines('localDeclaration'),
      ...createSdkPublicTypeImportLines('localDeclaration'),
      '',
      'const model: ModelPort = {',
      '  async generate(request) {',
      '    return {',
      "      content: request.messages.map((message) => message.content).join('\\n'),",
      "      finishReason: 'stop',",
      '      usage: { totalTokens: 1 },',
      '    };',
      '  },',
      '',
      '  async *stream() {',
      "    yield { type: 'content_delta', delta: 'ok' };",
      "    yield { type: 'done', response: { content: 'ok', finishReason: 'stop' } };",
      '  },',
      '};',
      '',
      'const kernelOptions: AgentKernelOptions = {',
      '  model,',
      "  modelCallMode: 'stream',",
      '  modelRequestDefaults: {',
      "    model: 'glm-5.2',",
      '    maxOutputTokens: 16,',
      '  },',
      '};',
      '',
      'const sessionOptions: SessionOptions = {',
      '  provider: {',
      "    type: 'openai-compatible',",
      "    apiKey: 'test-key',",
      "    baseUrl: 'https://example.invalid/v1',",
      '  },',
      "  model: 'glm-5.2',",
      '  allowedTools: [],',
      '  temperature: 0.2,',
      '  maxOutputTokens: 16,',
      '};',
      '',
      "const streamMessage: StreamMessage = { type: 'content', delta: 'ok', sessionId: 'session-id' };",
      '',
      'const chatConfig: ChatConfig = {',
      "  provider: 'openai-compatible',",
      "  apiKey: 'test-key',",
      "  baseUrl: 'https://example.invalid/v1',",
      "  model: 'glm-5.2',",
      '};',
      '',
      'const compatibleOptions: OpenAICompatibleModelPortOptions = {',
      "  apiKey: 'test-key',",
      "  baseUrl: 'https://example.invalid/v1',",
      "  model: 'glm-5.2',",
      '};',
      '',
      'const vercelOptions: VercelLanguageModelOptions = {',
      "  provider: 'openai-compatible',",
      "  apiKey: 'test-key',",
      "  baseUrl: 'https://example.invalid/v1',",
      "  model: 'glm-5.2',",
      '};',
      '',
      'const retryConfig: RetryConfig = {',
      '  maxRetries: 1,',
      '  initialDelayMs: 1,',
      '  maxDelayMs: 2,',
      '  backoffMultiplier: 2,',
      '  retryableStatusCodes: [429],',
      '  max529Retries: 1,',
      '};',
      '',
      'const toolPort: AgentToolPort = {',
      '  async list() {',
      '    return [];',
      '  },',
      '  async execute(toolCall) {',
      '    return { id: toolCall.id, name: toolCall.name, output: {} };',
      '  },',
      '};',
      '',
      "const agentToolCall: AgentToolCall = { id: 'tool-1', name: 'Read', input: {} };",
      "const agentStreamEvent: AgentStreamEvent = { type: 'result', content: 'ok' };",
      "const agentToolResult: AgentToolResult = { id: 'tool-1', name: 'Read', output: {} };",
      "const traceEvent: AgentTraceEvent = { type: 'turn_start', input: 'hello' };",
      'const agentTracePort: AgentTracePort = {',
      '  record() {},',
      '};',
      'const bufferedAgentTracePortOptions: BufferedAgentTracePortOptions = {',
      '  maxEvents: 1,',
      '};',
      'const bufferedAgentTracePort: BufferedAgentTracePort = {',
      '  record: agentTracePort.record,',
      '  getEvents() {',
      '    return [traceEvent];',
      '  },',
      '  clear() {},',
      '};',
      '',
      'const sdkErrorOptions: SdkErrorOptions = {',
      "  cause: new Error('typed cause'),",
      '};',
      '',
      'const runtimeContext: RuntimeContext = {',
      "  id: 'ctx',",
      '  capabilities: { filesystem: { roots: [], cwd: undefined } },',
      '};',
      '',
      "const sessionIdentity: Pick<ISession, 'sessionId' | 'isClosed'> = {",
      "  sessionId: 'session-id',",
      '  isClosed: false,',
      '};',
      '',
      'const toolDefinition: ToolDefinition = {',
      "  name: 'example_tool',",
      "  description: 'Example tool',",
      '  parameters: { type: \'object\', properties: {}, required: [] },',
      "  execute: async () => ({ success: true, llmContent: 'ok' }),",
      '};',
      '',
      'export const localDeclarationConsumer = {',
      '  agentStreamEvent,',
      '  agentToolCall,',
      '  agentToolResult,',
      '  agentTracePort,',
      '  chatConfig,',
      '  kernelOptions,',
      '  bufferedAgentTracePort,',
      '  bufferedAgentTracePortOptions,',
      '  compatibleOptions,',
      '  retryConfig,',
      '  runtimeContext,',
      '  sdkErrorOptions,',
      '  sessionIdentity,',
      '  sessionOptions,',
      '  streamMessage,',
      '  toolDefinition,',
      '  toolPort,',
      '  traceEvent,',
      '  vercelOptions,',
      '} satisfies {',
      '  agentStreamEvent: AgentStreamEvent;',
      '  agentToolCall: AgentToolCall;',
      '  agentToolResult: AgentToolResult;',
      '  agentTracePort: AgentTracePort;',
      '  bufferedAgentTracePort: BufferedAgentTracePort;',
      '  bufferedAgentTracePortOptions: BufferedAgentTracePortOptions;',
      '  chatConfig: ChatConfig;',
      '  kernelOptions: AgentKernelOptions;',
      '  compatibleOptions: OpenAICompatibleModelPortOptions;',
      '  retryConfig: RetryConfig;',
      '  runtimeContext: RuntimeContext;',
      '  sdkErrorOptions: SdkErrorOptions;',
      "  sessionIdentity: Pick<ISession, 'sessionId' | 'isClosed'>;",
      '  sessionOptions: SessionOptions;',
      '  streamMessage: StreamMessage;',
      '  toolDefinition: ToolDefinition;',
      '  toolPort: AgentToolPort;',
      '  traceEvent: AgentTraceEvent;',
      '  vercelOptions: VercelLanguageModelOptions;',
      '};',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    declarationTsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: [declarationEntry],
      },
      null,
      2,
    ),
    'utf8',
  );
  run('pnpm', ['exec', 'tsc', '--project', declarationTsconfig, '--pretty', 'false'], { cwd: packageRoot });
  console.log('local declaration consumer type-check passed');

  writeFileSync(
    agentEntry,
    [
      "import { AgentKernel } from '@blade-ai/agent';",
      "import { TokenBudget } from '@blade-ai/agent/budget';",
      "import { ExecutionEpoch } from '@blade-ai/agent/epoch';",
      "import { AgentKernel as AgentKernelFromSubpath } from '@blade-ai/agent/kernel';",
      "import { AsyncEventQueue, createInterruptAwareAbortSignal, decideNoToolTurn, decideTurnLimit, planToolExecution, resolveToolInterruptBehavior, toolUpdateToAgentEvent, ToolKind } from '@blade-ai/agent/loop';",
      "import * as agentProtocol from '@blade-ai/agent/protocol';",
      "import * as agentPorts from '@blade-ai/agent/ports';",
      "import { isOverflowRecoverable } from '@blade-ai/agent/recovery';",
      "import { VALID_SYSTEM_SOURCES, isValidSystemSource, modelResponseToAssistantMessage, toolResultToToolMessage } from '@blade-ai/agent/state';",
      "import { createBufferedAgentTracePort } from '@blade-ai/agent/tracing';",
      'const fakeModel = {',
      '  async generate() {',
      "    return { content: 'ok', finishReason: 'stop' };",
      '  },',
      '  async *stream() {',
      "    yield { type: 'done', response: { content: 'ok', finishReason: 'stop' } };",
      '  },',
      '};',
      'const kernel = new AgentKernel({ model: fakeModel });',
      'const budget = new TokenBudget({ maxTotalTokens: 10 });',
      'const epoch = new ExecutionEpoch();',
      'const queue = new AsyncEventQueue();',
      "queue.enqueue('event');",
      'queue.close();',
      'const kernelFromSubpath = new AgentKernelFromSubpath({ model: fakeModel });',
      "const kernelReady = typeof kernel.runTurn === 'function';",
      "const subpathKernelReady = typeof kernelFromSubpath.runTurn === 'function';",
      "const budgetReady = typeof budget.getSnapshot === 'function';",
      'const epochReady = epoch.isValid === true;',
      "const queueReady = typeof queue[Symbol.asyncIterator] === 'function';",
      "const decision = await decideNoToolTurn('All done', [], 1);",
      "const turnLimit = await decideTurnLimit({ maxTurns: 1, turnsCount: 1, contextMessages: [], toolCallsCount: 0, startTime: Date.now(), totalTokens: 0 });",
      "const toolPlan = planToolExecution([{ id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } }], { get: () => ({ kind: ToolKind.ReadOnly }) });",
      "const interruptBehavior = resolveToolInterruptBehavior({ get: () => ({ kind: ToolKind.Execute, interruptBehavior: 'cancel' }) }, 'Bash', {});",
      'const interruptSignal = createInterruptAwareAbortSignal({ interruptBehavior });',
      'interruptSignal.cleanup();',
      "const toolEvent = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall: { id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } } }, { get: () => ({ kind: ToolKind.ReadOnly }) });",
      "const overflow = isOverflowRecoverable(new Error('context_length_exceeded'));",
      'const systemSource = VALID_SYSTEM_SOURCES[0];',
      'const isSystemSource = isValidSystemSource(systemSource);',
      "const assistantMessage = modelResponseToAssistantMessage({ content: 'ok' });",
      "const toolMessage = toolResultToToolMessage({ id: 'call_read', name: 'Read', output: 'ok' }, { id: 'fallback', name: 'Fallback' });",
      'const trace = createBufferedAgentTracePort({ maxEvents: 1 });',
      "trace.record({ type: 'turn_start', input: 'browser trace smoke' });",
      "trace.record({ type: 'turn_end', content: 'ok', finishReason: 'stop' });",
      'const traceEvent = trace.getEvents()[0];',
      "console.log('local agent browser bundle', kernelReady, subpathKernelReady, budgetReady, epochReady, queueReady, decision.action, turnLimit.action, toolPlan.mode, interruptBehavior, toolEvent?.type, overflow, systemSource, isSystemSource, assistantMessage.role, toolMessage.role, traceEvent?.type);",
      "console.log('local agent protocol runtime empty', Object.keys(agentProtocol).length);",
      "console.log('local agent ports runtime empty', Object.keys(agentPorts).length);",
    ].join('\n'),
    'utf8',
  );

  await bundleWithEsbuildRetry({
    entryPoints: [agentEntry],
    bundle: true,
    platform: 'browser',
    conditions: ['browser'],
    format: 'esm',
    outfile: agentOutput,
    absWorkingDir: repoRoot,
    logLevel: 'silent',
  });
  assertNoDisallowedImports(agentOutput);
  const agentBundleOutput = run(process.execPath, [agentOutput], { cwd: packageRoot });
  assertIncludes(agentBundleOutput, 'local agent browser bundle', 'local agent browser bundle smoke');
  assertIncludes(
    agentBundleOutput,
    'true true true true true',
    'local agent browser bundle core runtime smoke did not execute',
  );
  assertIncludes(
    agentBundleOutput,
    'finish stop serial cancel tool_start true',
    'local agent browser bundle loop/recovery smoke did not execute',
  );
  assertIncludes(
    agentBundleOutput,
    'catalog true',
    'local agent browser bundle system-source smoke did not execute',
  );
  assertIncludes(
    agentBundleOutput,
    'assistant tool',
    'local agent browser bundle message projection smoke did not execute',
  );
  assertIncludes(
    agentBundleOutput,
    'turn_end',
    'local agent browser bundle tracing smoke did not execute',
  );
  assertIncludes(
    agentBundleOutput,
    'local agent protocol runtime empty 0',
    'local agent protocol runtime empty',
  );
  assertIncludes(
    agentBundleOutput,
    'local agent ports runtime empty 0',
    'local agent ports runtime empty',
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('entrypoint verification passed');
