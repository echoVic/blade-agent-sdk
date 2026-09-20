import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRegistry } from '@blade-ai/agent-sdk';

export const DEMO_PROVIDER_TYPE = 'web-starter-demo';
export const DEMO_MODEL = 'web-starter-demo';
export const REPORT_TITLE = 'Dependency risk report';
export const SECURITY_SECTION = 'Focus adjusted: security';
export const CONTINUATION_PREFIX = 'Continuing from the saved analysis';
export const NPM_CACHE_FLAG = '--cache /tmp/blade-npm-cache';

const UNPINNED_RANGE = /^(\^|~|\*$|latest$|>|<|x$)/;
const SECURITY_PATTERN = 'postinstall|preinstall|eval\\(|child_process';
const CONTINUATION_REQUEST = /继续|接着|continue|carry on|keep going|go on|resume|follow[- ]?up/i;

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tool calls made after `startIndex`, paired with the results the runtime returned. */
function toolResults(messages, startIndex) {
  const calls = new Map();
  const results = [];
  for (const message of messages.slice(startIndex)) {
    for (const call of message.tool_calls ?? []) {
      calls.set(call.id, {
        name: call.function.name,
        args: parseJson(call.function.arguments) ?? {},
      });
    }
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      if (call) results.push({ ...call, text: textOf(message.content) });
    }
  }
  return results;
}

/**
 * The provider is stateless: every call reads the conversation and decides the
 * next step. Order matters: a prior report followed by a message that actually
 * asks to continue means "continue"; a second user message inside the current
 * task means "steered"; otherwise follow the script. A new message after a
 * report that is not a continuation request starts a fresh task instead of
 * being trapped by the old report.
 */
export function analyzeConversation(messages) {
  const reportIndex = messages.findLastIndex(
    (message) => message.role === 'assistant' && textOf(message.content).includes(REPORT_TITLE),
  );
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const lastUserText = lastUserIndex === -1 ? '' : textOf(messages[lastUserIndex].content);
  if (reportIndex !== -1 && lastUserIndex > reportIndex && CONTINUATION_REQUEST.test(lastUserText)) {
    return { phase: 'continue', report: textOf(messages[reportIndex].content) };
  }
  const taskStart = reportIndex === -1 ? 0 : reportIndex + 1;
  const users = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role === 'user' && index >= taskStart);
  const steered = users.length >= 2;
  return {
    phase: steered ? 'steered' : 'script',
    steeringText: steered ? textOf(users.at(-1).message.content) : '',
    results: toolResults(messages, taskStart),
  };
}

function call(name, args, reasoning) {
  return {
    reasoning,
    response: {
      content: '',
      toolCalls: [
        {
          id: `demo-${randomUUID()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}

function text(content, reasoning) {
  return { reasoning, response: { content } };
}

function latest(results, name) {
  return results.findLast((result) => result.name === name);
}

function globFiles(globText) {
  return (globText ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

function parseManifest(readText) {
  const manifest = parseJson(readText ?? '');
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : undefined;
}

function unpinnedRanges(manifest) {
  return Object.entries({ ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) })
    .filter(([, range]) => typeof range === 'string' && UNPINNED_RANGE.test(range.trim()))
    .map(([name, range]) => `${name}@${range}`);
}

function npmLsSummary(bashText) {
  if (!bashText) return 'npm ls was not run';
  const result = parseJson(bashText);
  if (!result || typeof result !== 'object') return `npm ls did not return JSON: ${bashText.slice(0, 120)}`;
  const tree = parseJson(result.stdout ?? '');
  if (!tree) {
    const firstError = String(result.stderr ?? '').trim().split('\n')[0];
    return `npm ls exited ${result.exit_code ?? 'unknown'} without JSON output${firstError ? `: ${firstError}` : ''}`;
  }
  const problems = Array.isArray(tree.problems) ? tree.problems : [];
  return problems.length === 0
    ? 'npm ls: the installed tree matches the manifest'
    : `npm ls reported ${problems.length} problem(s), first: ${problems[0]}`;
}

function buildReport(results, root, steeringText = '') {
  const manifest = parseManifest(latest(results, 'Read')?.text);
  const files = globFiles(latest(results, 'Glob')?.text);
  const lockfile = files.find((file) => /lock/i.test(file));
  const runtimeDeps = Object.keys(manifest?.dependencies ?? {});
  const devDeps = Object.keys(manifest?.devDependencies ?? {});
  const ranges = unpinnedRanges(manifest);
  const lines = [
    `${REPORT_TITLE} for ${basename(root)}`,
    '',
    `- Direct dependencies: ${runtimeDeps.length + devDeps.length} (${runtimeDeps.length} runtime, ${devDeps.length} dev)`,
    `- Unpinned version ranges: ${ranges.length}${ranges.length ? ` (${ranges.slice(0, 6).join(', ')}${ranges.length > 6 ? ', ...' : ''})` : ''}`,
    `- Lockfile: ${lockfile ? `present (${lockfile})` : 'missing, installs are not reproducible'}`,
    `- engines.node: ${manifest?.engines?.node ?? 'not declared'}`,
    `- ${npmLsSummary(latest(results, 'Bash')?.text)}`,
  ];
  if (steeringText) {
    const grepText = latest(results, 'Grep')?.text ?? '';
    const matches = grepText.split('\n').filter((line) => /:\d+:/.test(line));
    lines.push(
      '',
      SECURITY_SECTION,
      `- Requested mid-run: "${steeringText}"`,
      `- Install hooks or dynamic execution matches: ${matches.length}`,
      ...matches.slice(0, 5).map((line) => `  ${line.trim()}`),
    );
  }
  lines.push(
    '',
    'Next steps:',
    ranges.length
      ? '- Pin the ranges above or commit a lockfile before the next release.'
      : '- Keep ranges pinned and review updates through the lockfile.',
    lockfile
      ? '- Run `npm audit` against the lockfile in CI.'
      : '- Generate a lockfile with `npm install --package-lock-only` and commit it.',
  );
  return lines.join('\n');
}

function continuation(report) {
  const count = /Direct dependencies: (\d+)/.exec(report)?.[1];
  const reviewed = count ? ` (${count} dependencies reviewed)` : '';
  return [
    `${CONTINUATION_PREFIX}${reviewed}.`,
    '',
    'Two follow-ups from that report:',
    '1. Pin any unpinned ranges and commit the lockfile, then re-run this analysis.',
    '2. Add `npm audit --omit=dev` to CI so new advisories fail the build instead of waiting for a manual review.',
  ].join('\n');
}

export function nextStep(messages, root) {
  const state = analyzeConversation(messages);
  if (state.phase === 'continue') {
    return text(continuation(state.report), 'The saved report is already in the transcript; extending it without new tool calls');
  }
  const { results } = state;
  if (state.phase === 'steered') {
    if (!latest(results, 'Grep')) {
      return call(
        'Grep',
        { pattern: SECURITY_PATTERN, path: root, output_mode: 'content' },
        `Focus changed: "${state.steeringText}". Scanning for install hooks and dynamic execution`,
      );
    }
    return text(buildReport(results, root, state.steeringText), 'Evidence collected; writing the security-focused report');
  }
  const glob = latest(results, 'Glob');
  if (!glob) {
    return call(
      'Glob',
      { pattern: '{package.json,package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock}', path: root },
      'Locating the manifest and lockfiles',
    );
  }
  if (!globFiles(glob.text).includes('package.json')) {
    return text(
      `No Node manifest found under ${root}: nothing named package.json matched, so there are no dependencies to assess. Point --root at a Node project to analyze it.`,
      'No package.json here; reporting that instead of guessing',
    );
  }
  if (!latest(results, 'Read')) {
    return call('Read', { file_path: join(root, 'package.json') }, 'Reading package.json');
  }
  if (!latest(results, 'Bash')) {
    return call(
      'Bash',
      { command: `npm ls --depth=0 --json ${NPM_CACHE_FLAG}` },
      'Checking the installed dependency tree offline',
    );
  }
  return text(buildReport(results, root), 'Evidence collected; writing the report');
}

export function createDemoProviderRegistry({ root, smoke = false }) {
  const pace = smoke ? 20 : 450;
  const chunkPace = smoke ? 5 : 40;
  return new ProviderRegistry([
    {
      type: DEMO_PROVIDER_TYPE,
      create(config) {
        return {
          async chat(messages, _tools, signal) {
            signal?.throwIfAborted();
            return nextStep(messages, root).response;
          },
          async sideQuery(_messages, signal) {
            signal?.throwIfAborted();
            return { content: `Analyze dependency risks under ${root} with Glob, Read, Bash and Grep.` };
          },
          async *streamChat(messages, _tools, signal) {
            signal?.throwIfAborted();
            const step = nextStep(messages, root);
            yield { reasoningContent: `${step.reasoning}.` };
            await delay(pace, undefined, { signal });
            if (step.response.toolCalls) {
              yield step.response;
            } else {
              for (const chunk of step.response.content.match(/[^]{1,48}/g) ?? ['']) {
                signal?.throwIfAborted();
                yield { content: chunk };
                await delay(chunkPace, undefined, { signal });
              }
            }
            yield {
              finishReason: step.response.toolCalls ? 'tool_calls' : 'stop',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          },
          getConfig() {
            return config;
          },
          updateConfig() {},
        };
      },
    },
  ]);
}
