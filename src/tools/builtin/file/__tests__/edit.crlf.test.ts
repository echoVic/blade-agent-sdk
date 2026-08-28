import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { MessageId, SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { editTool } from '../edit.js';
import { FileAccessTracker } from '../FileAccessTracker.js';
import { readTool } from '../read.js';

const roots: string[] = [];

afterEach(async () => {
  FileAccessTracker.resetInstance();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Edit CRLF offsets', () => {
  it('reports duplicate match line numbers using CRLF byte widths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edit-crlf-'));
    roots.push(root);
    const filePath = join(root, 'example.txt');
    const content = 'same\r\nmiddle\r\nsame\r\n';
    const sessionId = SessionId('edit-crlf-session');
    await writeFile(filePath, content);
    const contextSnapshot = createContextSnapshot(sessionId, 'turn-1', {
      capabilities: {
        filesystem: {
          roots: [root],
          cwd: root,
        },
      },
    });
    await collectToolExecution(
      readTool.execute(
        {
          file_path: filePath,
          encoding: 'utf8',
        },
        { sessionId, contextSnapshot },
      ),
    );

    const result = await collectToolExecution(
      editTool.execute(
        {
          file_path: filePath,
          old_string: 'same',
          new_string: 'changed',
          replace_all: false,
        },
        {
          sessionId,
          messageId: MessageId('message-1'),
          contextSnapshot,
        },
      ),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        details: {
          matches: [{ line: 1 }, { line: 3 }],
        },
      },
    });
    expect(await readFile(filePath, 'utf8')).toBe(content);
  });
});
