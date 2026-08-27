import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/identifiers.js';
import type { JsonObject } from '../../../../types/json.js';
import { collectToolExecution } from '../../../types/result.js';
import type { Tool } from '../../../types/tool.js';
import { notebookEditTool } from '../../notebook/notebookEdit.js';
import { editTool } from '../edit.js';
import { readTool } from '../read.js';
import { writeTool } from '../write.js';

describe('file tools runtime context', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'blade-file-runtime-'));
    workspaceRoot = join(tempRoot, 'workspace');
    outsideRoot = join(tempRoot, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('should return a friendly error when filesystem capability is unavailable', async () => {
    const invocation = readTool.build({
      file_path: '/tmp/example.txt',
      encoding: 'utf8',
    });
    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, {
        contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {}),
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('rejects reads outside configured filesystem roots', async () => {
    const outsideFile = join(outsideRoot, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    const invocation = readTool.build({
      file_path: outsideFile,
      encoding: 'utf8',
    });

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

  it('rejects reads through a symlink that escapes configured roots', async () => {
    const outsideFile = join(outsideRoot, 'secret.json');
    const alias = join(workspaceRoot, 'safe.json');
    await writeFile(outsideFile, '{"secret":true}');
    await symlink(outsideFile, alias);
    const invocation = readTool.build({
      file_path: alias,
      encoding: 'utf8',
    });

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

  it.each([
    {
      name: 'Write',
      tool: writeTool,
      params: {
        file_path: '',
        content: 'updated',
        encoding: 'utf8',
        create_directories: true,
      },
    },
    {
      name: 'Edit',
      tool: editTool,
      params: {
        file_path: '',
        old_string: 'original',
        new_string: 'updated',
        replace_all: false,
      },
    },
    {
      name: 'NotebookEdit',
      tool: notebookEditTool,
      params: {
        notebook_path: '',
        cell_id: 'cell-1',
        new_source: 'updated',
        edit_mode: 'replace',
      },
    },
  ] satisfies Array<{ name: string; tool: Tool; params: JsonObject }>)(
    'rejects $name targets outside configured filesystem roots',
    async ({ name, tool, params }) => {
      const outsideFile = join(
        outsideRoot,
        name === 'NotebookEdit' ? 'outside.ipynb' : 'outside.txt',
      );
      await writeFile(
        outsideFile,
        name === 'NotebookEdit'
          ? JSON.stringify({
              cells: [{ id: 'cell-1', cell_type: 'code', source: ['original'] }],
            })
          : 'original',
      );
      const pathKey = name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      const invocation = tool.build({
        ...params,
        [pathKey]: outsideFile,
      });

      const result = await collectToolExecution(
        invocation.execute(new AbortController().signal, {
          sessionId: SessionId('session-1'),
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
    },
  );
});
