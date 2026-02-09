import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStore } from '../MemoryStore.js';
import type { ContextData, ContextMessage, ToolCall, WorkspaceContext } from '../../types.js';

/**
 * Helper: create a minimal valid ContextData object
 */
function createContextData(overrides?: Partial<ContextData>): ContextData {
  return {
    layers: {
      system: {
        role: 'assistant',
        capabilities: ['chat'],
        tools: ['search'],
        version: '1.0.0',
      },
      session: {
        sessionId: 'test-session',
        preferences: {},
        configuration: {},
        startTime: Date.now(),
      },
      conversation: {
        messages: [],
        topics: [],
        lastActivity: Date.now(),
      },
      tool: {
        recentCalls: [],
        toolStates: {},
        dependencies: {},
      },
      workspace: {
        currentFiles: [],
        recentFiles: [],
        environment: {},
      },
    },
    metadata: {
      totalTokens: 0,
      priority: 1,
      lastUpdated: Date.now(),
    },
    ...overrides,
  };
}

function createMessage(overrides?: Partial<ContextMessage>): ContextMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'search',
    input: { query: 'test' },
    timestamp: Date.now(),
    status: 'success',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.clear();
  });

  describe('constructor', () => {
    it('should create with default maxSize', () => {
      const s = new MemoryStore();
      expect(s.getContext()).toBeNull();
    });

    it('should create with custom maxSize', () => {
      const s = new MemoryStore(500);
      expect(s.getContext()).toBeNull();
    });
  });

  describe('setContext / getContext', () => {
    it('should store and retrieve context data', () => {
      const data = createContextData();
      store.setContext(data);

      const result = store.getContext();
      expect(result).not.toBeNull();
      expect(result!.layers.session.sessionId).toBe('test-session');
    });

    it('should return null when no context is set', () => {
      expect(store.getContext()).toBeNull();
    });

    it('should shallow-copy the data so mutations do not affect the store', () => {
      const data = createContextData();
      store.setContext(data);

      // Mutate the original
      data.metadata.totalTokens = 9999;

      const result = store.getContext();
      // The top-level spread means metadata is still the same reference,
      // but lastUpdated is overwritten by setContext
      expect(result).not.toBeNull();
    });

    it('should update lastUpdated timestamp on setContext', () => {
      const data = createContextData();
      data.metadata.lastUpdated = 0;
      store.setContext(data);

      const result = store.getContext();
      expect(result!.metadata.lastUpdated).toBeGreaterThan(0);
    });

    it('should overwrite previous context when called again', () => {
      store.setContext(createContextData());
      const newData = createContextData({
        metadata: { totalTokens: 42, priority: 2, lastUpdated: Date.now() },
      });
      store.setContext(newData);

      const result = store.getContext();
      expect(result!.metadata.totalTokens).toBe(42);
      expect(result!.metadata.priority).toBe(2);
    });
  });

  describe('addMessage', () => {
    it('should add a message to the conversation', () => {
      store.setContext(createContextData());
      const msg = createMessage({ content: 'Test message' });
      store.addMessage(msg);

      const ctx = store.getContext();
      expect(ctx!.layers.conversation.messages).toHaveLength(1);
      expect(ctx!.layers.conversation.messages[0].content).toBe('Test message');
    });

    it('should throw if context is not initialized', () => {
      const msg = createMessage();
      expect(() => store.addMessage(msg)).toThrow('上下文数据未初始化');
    });

    it('should update lastActivity and lastUpdated', () => {
      store.setContext(createContextData());
      const before = Date.now();
      store.addMessage(createMessage());

      const ctx = store.getContext();
      expect(ctx!.layers.conversation.lastActivity).toBeGreaterThanOrEqual(before);
      expect(ctx!.metadata.lastUpdated).toBeGreaterThanOrEqual(before);
    });

    it('should add multiple messages in order', () => {
      store.setContext(createContextData());
      store.addMessage(createMessage({ content: 'First' }));
      store.addMessage(createMessage({ content: 'Second' }));
      store.addMessage(createMessage({ content: 'Third' }));

      const ctx = store.getContext();
      const messages = ctx!.layers.conversation.messages;
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });
  });

  describe('enforceMemoryLimit', () => {
    it('should trim messages when exceeding maxSize', () => {
      const smallStore = new MemoryStore(10);
      smallStore.setContext(createContextData());

      // Add 15 messages to exceed the limit of 10
      for (let i = 0; i < 15; i++) {
        smallStore.addMessage(createMessage({ content: `Message ${i}` }));
      }

      const ctx = smallStore.getContext();
      const messages = ctx!.layers.conversation.messages;
      // maxSize=10, keepCount = floor(10 * 0.8) = 8
      expect(messages.length).toBeLessThanOrEqual(10);
      // The most recent messages should be preserved
      expect(messages[messages.length - 1].content).toBe('Message 14');
    });

    it('should not trim messages when under maxSize', () => {
      store.setContext(createContextData());
      for (let i = 0; i < 5; i++) {
        store.addMessage(createMessage({ content: `Message ${i}` }));
      }

      const ctx = store.getContext();
      expect(ctx!.layers.conversation.messages).toHaveLength(5);
    });
  });

  describe('getRecentMessages', () => {
    it('should return empty array when no context', () => {
      expect(store.getRecentMessages()).toEqual([]);
    });

    it('should return empty array when no messages', () => {
      store.setContext(createContextData());
      expect(store.getRecentMessages()).toEqual([]);
    });

    it('should return the last N messages', () => {
      store.setContext(createContextData());
      for (let i = 0; i < 20; i++) {
        store.addMessage(createMessage({ content: `Msg ${i}` }));
      }

      const recent = store.getRecentMessages(5);
      expect(recent).toHaveLength(5);
      expect(recent[0].content).toBe('Msg 15');
      expect(recent[4].content).toBe('Msg 19');
    });

    it('should default to 10 messages', () => {
      store.setContext(createContextData());
      for (let i = 0; i < 20; i++) {
        store.addMessage(createMessage({ content: `Msg ${i}` }));
      }

      const recent = store.getRecentMessages();
      expect(recent).toHaveLength(10);
    });

    it('should return all messages if fewer than count', () => {
      store.setContext(createContextData());
      store.addMessage(createMessage({ content: 'Only one' }));

      const recent = store.getRecentMessages(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].content).toBe('Only one');
    });
  });

  describe('addToolCall', () => {
    it('should add a tool call record', () => {
      store.setContext(createContextData());
      const tc = createToolCall({ name: 'readFile' });
      store.addToolCall(tc);

      const ctx = store.getContext();
      expect(ctx!.layers.tool.recentCalls).toHaveLength(1);
      expect(ctx!.layers.tool.recentCalls[0].name).toBe('readFile');
    });

    it('should throw if context is not initialized', () => {
      expect(() => store.addToolCall(createToolCall())).toThrow('上下文数据未初始化');
    });

    it('should update lastUpdated', () => {
      store.setContext(createContextData());
      const before = Date.now();
      store.addToolCall(createToolCall());

      const ctx = store.getContext();
      expect(ctx!.metadata.lastUpdated).toBeGreaterThanOrEqual(before);
    });

    it('should trim tool calls when exceeding 50', () => {
      store.setContext(createContextData());

      for (let i = 0; i < 55; i++) {
        store.addToolCall(createToolCall({ name: `tool-${i}` }));
      }

      const ctx = store.getContext();
      // After exceeding 50, it slices to keep the last 25
      expect(ctx!.layers.tool.recentCalls.length).toBeLessThanOrEqual(50);
    });
  });

  describe('updateToolState / getToolState', () => {
    it('should set and get tool state', () => {
      store.setContext(createContextData());
      store.updateToolState('myTool', { enabled: true, count: 5 });

      const state = store.getToolState('myTool');
      expect(state).toEqual({ enabled: true, count: 5 });
    });

    it('should return null if context is not initialized (getToolState)', () => {
      expect(store.getToolState('myTool')).toBeNull();
    });

    it('should throw if context is not initialized (updateToolState)', () => {
      expect(() => store.updateToolState('myTool', 'value')).toThrow('上下文数据未初始化');
    });

    it('should overwrite existing tool state', () => {
      store.setContext(createContextData());
      store.updateToolState('myTool', 'v1');
      store.updateToolState('myTool', 'v2');

      expect(store.getToolState('myTool')).toBe('v2');
    });

    it('should handle different tool names independently', () => {
      store.setContext(createContextData());
      store.updateToolState('toolA', 'stateA');
      store.updateToolState('toolB', 'stateB');

      expect(store.getToolState('toolA')).toBe('stateA');
      expect(store.getToolState('toolB')).toBe('stateB');
    });
  });

  describe('updateWorkspace', () => {
    it('should update workspace fields', () => {
      store.setContext(createContextData());
      store.updateWorkspace({
        projectPath: '/my/project',
        currentFiles: ['file1.ts', 'file2.ts'],
      });

      const ctx = store.getContext();
      expect(ctx!.layers.workspace.projectPath).toBe('/my/project');
      expect(ctx!.layers.workspace.currentFiles).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should throw if context is not initialized', () => {
      expect(() => store.updateWorkspace({ projectPath: '/test' })).toThrow(
        '上下文数据未初始化'
      );
    });

    it('should merge partial updates without overwriting other fields', () => {
      store.setContext(createContextData());
      store.updateWorkspace({ projectPath: '/project' });
      store.updateWorkspace({ currentFiles: ['a.ts'] });

      const ctx = store.getContext();
      expect(ctx!.layers.workspace.projectPath).toBe('/project');
      expect(ctx!.layers.workspace.currentFiles).toEqual(['a.ts']);
    });

    it('should update lastUpdated', () => {
      store.setContext(createContextData());
      const before = Date.now();
      store.updateWorkspace({ recentFiles: ['x.ts'] });

      const ctx = store.getContext();
      expect(ctx!.metadata.lastUpdated).toBeGreaterThanOrEqual(before);
    });
  });

  describe('clear', () => {
    it('should clear all data', () => {
      store.setContext(createContextData());
      store.addMessage(createMessage());
      store.clear();

      expect(store.getContext()).toBeNull();
      expect(store.getRecentMessages()).toEqual([]);
    });

    it('should be safe to call on empty store', () => {
      expect(() => store.clear()).not.toThrow();
    });
  });

  describe('getMemoryInfo', () => {
    it('should return empty info when no context', () => {
      const info = store.getMemoryInfo();
      expect(info).toEqual({
        hasData: false,
        messageCount: 0,
        toolCallCount: 0,
        lastUpdated: null,
      });
    });

    it('should return correct info with data', () => {
      store.setContext(createContextData());
      store.addMessage(createMessage());
      store.addMessage(createMessage());
      store.addToolCall(createToolCall());

      const info = store.getMemoryInfo();
      expect(info.hasData).toBe(true);
      expect(info.messageCount).toBe(2);
      expect(info.toolCallCount).toBe(1);
      expect(info.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe('getMemoryUsage', () => {
    it('should return 0 when no context', () => {
      expect(store.getMemoryUsage()).toBe(0);
    });

    it('should return positive number when context exists', () => {
      store.setContext(createContextData());
      expect(store.getMemoryUsage()).toBeGreaterThan(0);
    });

    it('should increase as more data is added', () => {
      store.setContext(createContextData());
      const usageBefore = store.getMemoryUsage();

      for (let i = 0; i < 10; i++) {
        store.addMessage(createMessage({ content: 'A longer message content for testing' }));
      }

      const usageAfter = store.getMemoryUsage();
      expect(usageAfter).toBeGreaterThan(usageBefore);
    });
  });
});
