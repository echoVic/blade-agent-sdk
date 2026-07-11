import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createReadTool } from '../local/file/read.js';
import type { LocalFileSystemPort } from '../local/file/filesystem.js';

function filesystemContext(root: string) {
  return {
    sessionId: 'local-file-session',
    contextSnapshot: {
      sessionId: 'local-file-session',
      turnId: 'local-file-turn',
      context: {
        capabilities: {
          filesystem: {
            roots: [root],
            cwd: root,
          },
        },
      },
      filesystemRoots: [root],
      cwd: root,
      environment: {},
    },
  };
}

describe('agent-sdk local file tools', () => {
  it('reads text files with line slicing and metadata from package-local code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-local-read-'));
    const filePath = join(root, 'example.ts');
    await writeFile(filePath, 'first\nsecond\nthird\n', 'utf8');

    const result = await createReadTool()
      .build({ file_path: filePath, offset: 1, limit: 1, encoding: 'utf8' })
      .execute(new AbortController().signal, undefined, filesystemContext(root));

    expect(result).toMatchObject({
      success: true,
      llmContent: '     2→second',
      metadata: {
        file_path: filePath,
        file_type: '.ts',
        encoding: 'utf8',
        lines_read: 1,
        total_lines: 4,
        start_line: 2,
        end_line: 2,
      },
    });
  });

  it('rejects reads when the runtime context has no filesystem capability', async () => {
    const result = await createReadTool()
      .build({ file_path: '/tmp/example.txt', encoding: 'utf8' })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'local-file-session',
        contextSnapshot: {
          sessionId: 'local-file-session',
          turnId: 'local-file-turn',
          context: {},
          filesystemRoots: [],
          cwd: undefined,
          environment: {},
        },
      });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'permission_denied',
        message: 'No filesystem access in current context',
      },
    });
  });

  it('rejects relative paths before touching the filesystem', () => {
    expect(() => createReadTool().build({ file_path: 'relative.txt' })).toThrow(
      'File path must be absolute',
    );
  });

  it('accepts runtime-neutral binary bytes through the local filesystem port', async () => {
    const fileSystem: LocalFileSystemPort = {
      async exists() { return true; },
      async stat() {
        return { size: 3, isDirectory: false, mtime: new Date(0) };
      },
      async readTextFile() { return ''; },
      async readBinaryFile() { return new Uint8Array([0, 1, 2]); },
    };

    const result = await createReadTool({ fileSystem })
      .build({ file_path: '/tmp/example.png', encoding: 'base64' })
      .execute(new AbortController().signal, undefined, filesystemContext('/tmp'));

    expect(result).toMatchObject({
      success: true,
      llmContent: 'AAEC',
      metadata: {
        encoding: 'base64',
        is_binary: true,
      },
    });
  });

  it('uses base64 automatically for recognized binary extensions', async () => {
    const fileSystem: LocalFileSystemPort = {
      async exists() { return true; },
      async stat() {
        return { size: 3, isDirectory: false, mtime: new Date(0) };
      },
      async readTextFile() { return ''; },
      async readBinaryFile() { return new Uint8Array([0, 1, 2]); },
    };

    const result = await createReadTool({
      fileSystem,
      fileAccessTracker: { recordFileRead: async () => {} },
    })
      .build({ file_path: '/tmp/example.png' })
      .execute(new AbortController().signal, undefined, filesystemContext('/tmp'));

    expect(result).toMatchObject({
      success: true,
      llmContent: 'AAEC',
      metadata: { encoding: 'base64', is_binary: true },
    });
  });

  it('preserves explicit binary encoding for runtime-neutral bytes', async () => {
    const fileSystem: LocalFileSystemPort = {
      async exists() { return true; },
      async stat() {
        return { size: 3, isDirectory: false, mtime: new Date(0) };
      },
      async readTextFile() { return ''; },
      async readBinaryFile() { return new Uint8Array([65, 66, 67]); },
    };

    const result = await createReadTool({
      fileSystem,
      fileAccessTracker: { recordFileRead: async () => {} },
    })
      .build({ file_path: '/tmp/example.bin', encoding: 'binary' })
      .execute(new AbortController().signal, undefined, filesystemContext('/tmp'));

    expect(result).toMatchObject({
      success: true,
      llmContent: 'ABC',
      metadata: { encoding: 'binary', is_binary: true },
    });
  });

  it('preserves structured details for unexpected filesystem failures', async () => {
    const failure = new Error('read exploded');
    const fileSystem: LocalFileSystemPort = {
      async exists() { return true; },
      async stat() {
        return { size: 1, isDirectory: false, mtime: new Date(0) };
      },
      async readTextFile() { throw failure; },
      async readBinaryFile() { return new Uint8Array(); },
    };

    const result = await createReadTool({
      fileSystem,
      fileAccessTracker: { recordFileRead: async () => {} },
    })
      .build({ file_path: '/tmp/example.txt' })
      .execute(new AbortController().signal, undefined, filesystemContext('/tmp'));

    expect(result).toMatchObject({
      success: false,
      llmContent: 'File read failed: read exploded',
      error: {
        message: 'read exploded',
        details: failure,
      },
    });
  });

  it('includes the package-local Read tool in the explicit builtin provider', async () => {
    await expect(getBuiltinTools()).resolves.toMatchObject([
      { name: 'Read' },
    ]);
  });
});
