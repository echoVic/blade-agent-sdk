import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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
    const result = await collectToolExecution(
      globTool.execute(
        {
          pattern: '**/*.ts',
          max_results: 10,
          include_directories: false,
          case_sensitive: false,
        },
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Grep without filesystem capability', async () => {
    const result = await collectToolExecution(
      grepTool.execute(
        {
          pattern: 'needle',
          output_mode: 'files_with_matches',
          '-i': false,
          '-n': true,
          multiline: false,
        },
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Bash without an explicit cwd or filesystem context cwd', async () => {
    const result = await collectToolExecution(
      bashTool.execute(
        {
          command: 'pwd',
          timeout: 1000,
          run_in_background: false,
        },
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No working directory available');
  });

  it('should reject Bash cwd outside configured filesystem roots', async () => {
    const result = await collectToolExecution(
      bashTool.execute(
        {
          command: 'pwd',
          cwd: outsideRoot,
          timeout: 1000,
          run_in_background: false,
        },
        {
          contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
            capabilities: {
              filesystem: {
                roots: [workspaceRoot],
                cwd: workspaceRoot,
              },
            },
          }),
        },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.type).toBe('permission_denied');
    expect(result.error?.message).toContain('outside authorized roots');
  });

  it('should allow Bash cwd inside configured filesystem roots', async () => {
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const result = await collectToolExecution(
      bashTool.execute(
        {
          command: 'pwd',
          cwd: workspaceRoot,
          timeout: 1000,
          run_in_background: false,
        },
        {
          contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
            capabilities: {
              filesystem: {
                roots: [workspaceRoot],
                cwd: workspaceRoot,
              },
            },
          }),
        },
      ),
    );

    expect(result).toMatchObject({
      status: 'success',
      model: { exit_code: 0 },
    });
    const stdout =
      result.model && typeof result.model === 'object' && 'stdout' in result.model
        ? result.model.stdout
        : '';
    expect(String(stdout)).toContain(canonicalWorkspaceRoot);
  });

  it.each([
    ['Glob', globTool, { pattern: '**/*.ts' }],
    ['Grep', grepTool, { pattern: 'needle' }],
  ])('should reject %s paths outside configured filesystem roots', async (_name, tool, params) => {
    const result = await collectToolExecution(
      tool.execute(
        { ...params, path: outsideRoot },
        {
          contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
            capabilities: {
              filesystem: {
                roots: [workspaceRoot],
                cwd: workspaceRoot,
              },
            },
          }),
        },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.type).toBe('permission_denied');
    expect(result.error?.message).toContain('outside authorized roots');
  });
});
