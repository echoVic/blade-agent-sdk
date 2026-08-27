import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { SessionId } from '../../../types/identifiers.js';
import { collectToolExecution } from '../../types/result.js';
import { globTool } from '../search/glob.js';
import { grepTool } from '../search/grep.js';
import { bashTool } from '../shell/bash.js';

const emptySnapshot = createContextSnapshot(SessionId('session-1'), 'turn-1', {});

describe('tool runtime context guards', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'blade-tool-context-'));
    workspaceRoot = join(tempRoot, 'workspace');
    outsideRoot = join(tempRoot, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('should reject Glob without filesystem capability', async () => {
    const invocation = globTool.build({
      pattern: '**/*.ts',
      max_results: 10,
      include_directories: false,
      case_sensitive: false,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, { contextSnapshot: emptySnapshot }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Grep without filesystem capability', async () => {
    const invocation = grepTool.build({
      pattern: 'needle',
      output_mode: 'files_with_matches',
      '-i': false,
      '-n': true,
      multiline: false,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, { contextSnapshot: emptySnapshot }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Bash without an explicit cwd or filesystem context cwd', async () => {
    const invocation = bashTool.build({
      command: 'pwd',
      timeout: 1000,
      run_in_background: false,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, { contextSnapshot: emptySnapshot }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No working directory available');
  });

  it.each([
    ['Glob', globTool, { pattern: '**/*.ts' }],
    ['Grep', grepTool, { pattern: 'needle' }],
  ])('should reject %s paths outside configured filesystem roots', async (_name, tool, params) => {
    const invocation = tool.build({ ...params, path: outsideRoot });
    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, {
        contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
          capabilities: {
            filesystem: {
              roots: [workspaceRoot],
              cwd: workspaceRoot,
            },
          },
        }),
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.type).toBe('permission_denied');
    expect(result.error?.message).toContain('outside authorized roots');
  });
});
