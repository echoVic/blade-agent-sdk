import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeConversation,
  CONTINUATION_PREFIX,
  nextStep,
  REPORT_TITLE,
  SECURITY_SECTION,
} from './DemoProvider.mjs';

const root = '/workspace/demo';
const user = (content) => ({ role: 'user', content });
const assistantCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const toolResult = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const toolName = (step) => step.response.toolCalls?.[0]?.function.name;

const globText = 'Found 1 file(s) matching:\n\n- package.json\n';
const manifest = JSON.stringify({
  name: 'demo',
  dependencies: { 'left-pad': '^1.3.0', 'is-odd': '*' },
  devDependencies: { vitest: '3.0.0' },
});
const bashText = JSON.stringify({ stdout: JSON.stringify({ problems: ['missing: left-pad@^1.3.0'] }), stderr: '', exit_code: 1 });
// What InvocationStage now renders when a priority-now steer interrupts a running Bash call.
const interruptedBashText = 'Tool execution failed: Tool execution was interrupted by a new instruction';

test('follows the script: Glob, Read, Bash, then a report', () => {
  const messages = [user('Analyze this project')];
  assert.equal(toolName(nextStep(messages, root)), 'Glob');
  messages.push(assistantCall('c1', 'Glob', {}), toolResult('c1', globText));
  assert.equal(toolName(nextStep(messages, root)), 'Read');
  messages.push(assistantCall('c2', 'Read', {}), toolResult('c2', manifest));
  assert.equal(toolName(nextStep(messages, root)), 'Bash');
  messages.push(assistantCall('c3', 'Bash', {}), toolResult('c3', bashText));
  const report = nextStep(messages, root).response.content;
  assert.match(report, new RegExp(REPORT_TITLE));
  assert.match(report, /Direct dependencies: 3/);
  assert.match(report, /Unpinned version ranges: 2/);
  assert.match(report, /Lockfile: missing/);
  assert.match(report, /npm ls reported 1 problem/);
  assert.doesNotMatch(report, new RegExp(SECURITY_SECTION));
});

test('a second user message mid-task switches to the security branch', () => {
  const messages = [
    user('Analyze this project'),
    assistantCall('c1', 'Glob', {}),
    toolResult('c1', globText),
    user('Focus on security issues'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'steered');
  assert.equal(toolName(nextStep(messages, root)), 'Grep');
  messages.push(assistantCall('c2', 'Grep', {}), toolResult('c2', 'package.json:9:    "postinstall": "node ./setup.js"\n'));
  const report = nextStep(messages, root).response.content;
  assert.match(report, new RegExp(SECURITY_SECTION));
  assert.match(report, /matches: 1/);
});

test('steering interrupts Bash: the script retries once, then falls through to Grep on a second interruption', () => {
  const messages = [
    user('Analyze this project'),
    assistantCall('c1', 'Glob', {}),
    toolResult('c1', globText),
    assistantCall('c2', 'Read', {}),
    toolResult('c2', manifest),
    assistantCall('c3', 'Bash', {}),
    toolResult('c3', interruptedBashText),
    user('Focus on security issues'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'steered');
  // First interrupted Bash result: retry Bash rather than moving straight to Grep.
  assert.equal(toolName(nextStep(messages, root)), 'Bash');

  messages.push(assistantCall('c4', 'Bash', {}), toolResult('c4', interruptedBashText));
  // Second interrupted Bash result: give up on the retry and move on to Grep.
  assert.equal(toolName(nextStep(messages, root)), 'Grep');

  messages.push(assistantCall('c5', 'Grep', {}), toolResult('c5', 'no matches'));
  const report = nextStep(messages, root).response.content;
  assert.match(report, /could not complete/);
  assert.doesNotMatch(report, /Tool execution failed/);
  assert.doesNotMatch(report, /did not return JSON/);
});

test('steering interrupts Bash: a successful retry reports both the interruption and the real result', () => {
  const messages = [
    user('Analyze this project'),
    assistantCall('c1', 'Glob', {}),
    toolResult('c1', globText),
    assistantCall('c2', 'Read', {}),
    toolResult('c2', manifest),
    assistantCall('c3', 'Bash', {}),
    toolResult('c3', interruptedBashText),
    user('Focus on security issues'),
  ];
  assert.equal(toolName(nextStep(messages, root)), 'Bash');

  messages.push(assistantCall('c4', 'Bash', {}), toolResult('c4', bashText));
  assert.equal(toolName(nextStep(messages, root)), 'Grep');

  messages.push(assistantCall('c5', 'Grep', {}), toolResult('c5', 'no matches'));
  const report = nextStep(messages, root).response.content;
  assert.match(report, /was interrupted by this instruction and retried/);
  assert.match(report, /npm ls reported 1 problem/);
  assert.doesNotMatch(report, /Tool execution failed/);
  assert.doesNotMatch(report, /did not return JSON/);
});

test('a new user message after a report continues without tools', () => {
  const messages = [
    user('Analyze this project'),
    { role: 'assistant', content: `${REPORT_TITLE} for demo\n\n- Direct dependencies: 3 (2 runtime, 1 dev)` },
    user('Continue the analysis'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'continue');
  const step = nextStep(messages, root);
  assert.equal(step.response.toolCalls, undefined);
  assert.match(step.response.content, new RegExp(`${CONTINUATION_PREFIX} \\(3 dependencies reviewed\\)`));
});

test('reports a missing manifest instead of reading it', () => {
  const messages = [user('Analyze'), assistantCall('c1', 'Glob', {}), toolResult('c1', 'No files found')];
  const step = nextStep(messages, root);
  assert.equal(step.response.toolCalls, undefined);
  assert.match(step.response.content, /No Node manifest/);
});

test('an unrelated question after a report re-enters the script instead of continuing', () => {
  const messages = [
    user('Analyze this project'),
    { role: 'assistant', content: `${REPORT_TITLE} for demo\n\n- Direct dependencies: 3 (2 runtime, 1 dev)` },
    user('check the test coverage'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'script');
  const step = nextStep(messages, root);
  assert.equal(toolName(step), 'Glob');
  assert.doesNotMatch(step.response.content, new RegExp(CONTINUATION_PREFIX));
});

test('a no-manifest response is not mistaken for a saved report', () => {
  const messages = [user('Analyze'), assistantCall('c1', 'Glob', {}), toolResult('c1', 'No files found')];
  const noManifest = nextStep(messages, root);
  messages.push({ role: 'assistant', content: noManifest.response.content }, user('Continue the analysis'));
  assert.notEqual(analyzeConversation(messages).phase, 'continue');
  const step = nextStep(messages, root);
  assert.doesNotMatch(step.response.content, new RegExp(CONTINUATION_PREFIX));
  assert.doesNotMatch(step.response.content, /\(the dependencies/);
});
