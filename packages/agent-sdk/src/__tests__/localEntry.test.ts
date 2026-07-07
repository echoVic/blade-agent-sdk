import { describe, expect, it } from 'vitest';
import {
  FileSystemMemoryStore,
  MemoryManager,
  SandboxExecutor,
  SandboxService,
  createMemoryReadTool,
  createMemoryWriteTool,
  createSdkMcpServer,
  getBuiltinTools,
  getSandboxExecutor,
  getSandboxService,
  tool,
} from '../local/index.js';

describe('agent-sdk local entry', () => {
  it('keeps node-local adapter exports available through the package-local local entry', () => {
    expect(createSdkMcpServer).toBeTypeOf('function');
    expect(tool).toBeTypeOf('function');
    expect(FileSystemMemoryStore).toBeTypeOf('function');
    expect(MemoryManager).toBeTypeOf('function');
    expect(SandboxExecutor).toBeTypeOf('function');
    expect(SandboxService).toBeTypeOf('function');
    expect(getSandboxExecutor).toBeTypeOf('function');
    expect(getSandboxService).toBeTypeOf('function');
    expect(getBuiltinTools).toBeTypeOf('function');
    expect(createMemoryReadTool).toBeTypeOf('function');
    expect(createMemoryWriteTool).toBeTypeOf('function');
  });
});
