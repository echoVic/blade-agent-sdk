import { defineTool, ToolKind } from '@blade-ai/agent-sdk/tools';

export const GREETING_PATH = 'src/greeting.sh';
export const TEST_PATH = 'test/greeting.test.sh';
export const ORIGINAL_GREETING = '#!/bin/sh\nset -eu\nprintf \'Hello %s\\n\' "${1:-World}"\n';
export const CORRECTED_GREETING = '#!/bin/sh\nset -eu\nprintf \'Hello, %s!\\n\' "${1:-World}"\n';
export const GREETING_TEST = `#!/bin/sh
set -eu
actual=$(sh src/greeting.sh Blade)
if [ "$actual" != 'Hello, Blade!' ]; then
  printf 'FAIL greeting: expected Hello, Blade!; got %s\\n' "$actual"
  exit 1
fi
printf 'PASS greeting: Hello, Blade!\\n'
actual=$(sh src/greeting.sh)
if [ "$actual" != 'Hello, World!' ]; then
  printf 'FAIL default greeting: expected Hello, World!; got %s\\n' "$actual"
  exit 1
fi
printf 'PASS default greeting: Hello, World!\\n'
`;

// These programs are fixed application code. Model input is passed only as argv/stdin.
const READ_FILE = `set -eu
case "$1" in src/greeting.sh) parent=src ;; test/greeting.test.sh) parent=test ;; *) exit 64 ;; esac
test ! -L "$parent" && test -d "$parent" && test ! -L "$1" && test -f "$1" || exit 65
test "$(wc -c < "$1")" -le 16384 || exit 66
cat "$1"`;

const WRITE_FILE = `set -eu
test "$1" = src/greeting.sh || exit 64
test ! -L src && test -d src && test ! -L "$1" && test -f "$1" || exit 65
temporary=src/.greeting.sh.blade-tmp
expected=src/.greeting.sh.blade-expected
test ! -e "$temporary" && test ! -L "$temporary" && test ! -e "$expected" && test ! -L "$expected" || exit 65
trap 'rm -f "$temporary" "$expected"' EXIT
umask 077
cat > "$temporary"
printf '%s' "$2" > "$expected"
if cmp -s "$1" "$temporary"; then
  printf unchanged
elif cmp -s "$1" "$expected"; then
  mv "$temporary" "$1"
  printf written
else
  printf 'File changed since it was read' >&2
  exit 73
fi`;

const RUN_TESTS = `set -eu
test ! -L src && test -d src && test ! -L test && test -d test || exit 65
test ! -L src/greeting.sh && test -f src/greeting.sh || exit 65
test ! -L test/greeting.test.sh && test -f test/greeting.test.sh || exit 65
test "$(cat test/greeting.test.sh)" = "$1" || exit 65
sh test/greeting.test.sh`;

function failure(tool, message) {
  return {
    status: 'error',
    model: { tool, error: message },
    error: { type: 'validation_error', message },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

/** A deliberately bounded repository exercise, with no arbitrary command or path access. */
export function createRepositoryTools({ host, getHandle, checkpoint }) {
  if (!host || typeof getHandle !== 'function' || typeof checkpoint !== 'function') {
    throw new TypeError('Repository tools require host, getHandle, and checkpoint');
  }
  const exec = async (program, args, signal, stdin) => {
    signal?.throwIfAborted();
    const handle = await getHandle(signal);
    const result = await host.exec(handle.executionId, {
      command: '/bin/sh',
      args: ['-c', program, 'blade-repository', ...args],
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: 10_000,
      signal,
    });
    return { handle, result };
  };

  return [
    defineTool({
      name: 'RepoRead',
      description: 'Read src/greeting.sh or the trusted test/greeting.test.sh in the isolated fixture repository.',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', enum: [GREETING_PATH, TEST_PATH] } },
        required: ['file_path'],
        additionalProperties: false,
      },
      async *execute(params, context) {
        if (!hasOnlyKeys(params, ['file_path']) || ![GREETING_PATH, TEST_PATH].includes(params.file_path)) {
          return failure('RepoRead', 'Only the fixture source and test files may be read');
        }
        const { result } = await exec(READ_FILE, [params.file_path], context.signal);
        if (result.exitCode !== 0) {
          return failure('RepoRead', 'The file is missing, oversized, or a symbolic link');
        }
        return {
          status: 'success',
          model: { tool: 'RepoRead', file_path: params.file_path, content: result.stdout },
          display: { summary: `Read ${params.file_path}\n${result.stdout}` },
        };
      },
    }),
    defineTool({
      name: 'RepoWrite',
      description: 'Replace src/greeting.sh after approval. Supply its exact content from RepoRead as expected_content. Writes are limited to 16 KiB; retries of an already applied write are idempotent.',
      kind: ToolKind.Write,
      sideEffect: 'idempotent',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', enum: [GREETING_PATH] },
          expected_content: { type: 'string', maxLength: 16_384 },
          content: { type: 'string', maxLength: 16_384 },
        },
        required: ['file_path', 'expected_content', 'content'],
        additionalProperties: false,
      },
      async *execute(params, context) {
        if (!hasOnlyKeys(params, ['file_path', 'expected_content', 'content'])
          || params.file_path !== GREETING_PATH
          || typeof params.content !== 'string' || params.content.includes('\0')
          || Buffer.byteLength(params.content, 'utf8') > 16_384
          || typeof params.expected_content !== 'string' || params.expected_content.includes('\0')
          || Buffer.byteLength(params.expected_content, 'utf8') > 16_384) {
          return failure('RepoWrite', 'Write only src/greeting.sh using text and expected_content of at most 16 KiB');
        }
        const { handle, result } = await exec(
          WRITE_FILE,
          [params.file_path, params.expected_content],
          context.signal,
          params.content,
        );
        if (result.exitCode !== 0) {
          return failure('RepoWrite', result.exitCode === 73
            ? 'File changed since it was read; read it again before requesting approval'
            : 'The source path is not a regular fixture file');
        }
        await checkpoint({
          executionId: handle.executionId,
          path: params.file_path,
          signal: context.signal,
        });
        return {
          status: 'success',
          display: { summary: `${result.stdout === 'written' ? 'Updated' : 'Verified'} ${params.file_path}; workspace saved.` },
          model: {
            tool: 'RepoWrite',
            file_path: params.file_path,
            changed: result.stdout === 'written',
            before: params.expected_content,
            after: params.content,
          },
        };
      },
    }),
    defineTool({
      name: 'RepoRunTests',
      description: 'Run the fixed, verified greeting tests in the isolated repository and return their actual exit code and output.',
      kind: ToolKind.Execute,
      sideEffect: 'non_idempotent',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async *execute(params, context) {
        if (!hasOnlyKeys(params, [])) {
          return failure('RepoRunTests', 'The test command is fixed and accepts no arguments');
        }
        const { result } = await exec(RUN_TESTS, [GREETING_TEST.trimEnd()], context.signal);
        if (result.exitCode === 65) {
          return failure('RepoRunTests', 'Refusing to execute modified tests or symbolic links');
        }
        return {
          status: 'success',
          display: { summary: `Tests ${result.exitCode === 0 ? 'passed' : 'failed'} (exit ${result.exitCode}).\n${result.stdout}${result.stderr}` },
          model: {
            tool: 'RepoRunTests',
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      },
    }),
  ];
}
