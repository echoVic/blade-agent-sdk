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
  const aiEntry = join(tempDir, 'ai-entry.mjs');
  const agentEntry = join(tempDir, 'agent-client-entry.ts');
  const agentOutput = join(tempDir, 'agent-bundle.js');
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
