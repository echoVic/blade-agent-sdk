import { describe, expect, it } from 'vitest';
import {
  FileSystemMemoryStore,
  MemoryManager,
  SubagentExecutor,
  SubagentRegistry,
  createMemoryReadTool,
  createMemoryWriteTool,
} from './index.js';

describe('root exports', () => {
  it('exports the opt-in memory and subagent primitives', () => {
    expect(MemoryManager).toBeDefined();
    expect(FileSystemMemoryStore).toBeDefined();
    expect(createMemoryReadTool).toBeDefined();
    expect(createMemoryWriteTool).toBeDefined();
    expect(SubagentRegistry).toBeDefined();
    expect(SubagentExecutor).toBeDefined();
  });
});
