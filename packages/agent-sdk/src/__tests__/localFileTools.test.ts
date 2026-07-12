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

  const noopWriteTextFile = async (_path: string, _content: string): Promise<void> => {};
  const noopMkdir = async (_path: string, _options?: { recursive?: boolean; mode?: number }): Promise<void> => {};

  it('accepts runtime-neutral binary bytes through the local filesystem port', async () => {
    const fileSystem: LocalFileSystemPort = {
      async exists() { return true; },
      async stat() {
        return { size: 3, isDirectory: false, mtime: new Date(0) };
      },
      async readTextFile() { return ''; },
      async readBinaryFile() { return new Uint8Array([0, 1, 2]); },
      writeTextFile: noopWriteTextFile,
      mkdir: noopMkdir,
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
      writeTextFile: noopWriteTextFile,
      mkdir: noopMkdir,
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
      writeTextFile: noopWriteTextFile,
      mkdir: noopMkdir,
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
      writeTextFile: noopWriteTextFile,
      mkdir: noopMkdir,
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

  it('includes the package-local Read, Write, Edit, Grep, Glob, and NotebookEdit tools in the explicit builtin provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write']);
  });
});

describe('agent-sdk local Write tool', () => {
  it('writes a text file and returns metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-local-write-'));
    const filePath = join(root, 'output.ts');
    const content = 'export const x = 1;\n';

    const { createWriteTool } = await import('../local/file/write.js');

    const result = await createWriteTool()
      .build({ file_path: filePath, content, encoding: 'utf8' })
      .execute(new AbortController().signal, undefined, filesystemContext(root));

    expect(result).toMatchObject({
      success: true,
      metadata: {
        file_path: filePath,
        summary: 'Wrote 2 lines to output.ts',
      },
    });
  });

  it('rejects writes when the runtime context has no filesystem capability', async () => {
    const { createWriteTool } = await import('../local/file/write.js');

    const result = await createWriteTool()
      .build({ file_path: '/tmp/example.txt', content: 'hello', encoding: 'utf8' })
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

  it('rejects relative paths before touching the filesystem', async () => {
    const { createWriteTool } = await import('../local/file/write.js');
    expect(() => createWriteTool().build({ file_path: 'relative.txt', content: 'hi' })).toThrow(
      'File path must be absolute',
    );
  });

  it('rejects writing to an unread file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-local-write-unread-'));
    const filePath = join(root, 'untracked.ts');

    // Create a file without tracking it in the access tracker
    await writeFile(filePath, 'existing content\n', 'utf8');

    const { createWriteTool } = await import('../local/file/write.js');

    const result = await createWriteTool()
      .build({ file_path: filePath, content: 'new content\n', encoding: 'utf8' })
      .execute(new AbortController().signal, undefined, filesystemContext(root));

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'permission_denied',
        message: `File not read: ${filePath}`,
      },
    });
  });

  it('creates directories automatically when create_directories is true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sdk-local-write-dir-'));
    const nestedDir = join(root, 'nested', 'path');
    const filePath = join(nestedDir, 'output.txt');

    const { createWriteTool } = await import('../local/file/write.js');

    const result = await createWriteTool()
      .build({ file_path: filePath, content: 'hello', encoding: 'utf8', create_directories: true })
      .execute(new AbortController().signal, undefined, filesystemContext(root));

    expect(result).toMatchObject({
      success: true,
      metadata: {
        file_path: filePath,
        create_directories: true,
      },
    });

    // Verify the directory was created
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(filePath, 'utf8');
    expect(written).toBe('hello');
  });
});
