import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('Agent type ownership', () => {
  it('keeps AgentOptions public and gives internal runtime options a distinct name', () => {
    const publicAgent = source('src/agent/createAgent.ts');
    const internalAgent = source('src/agent/types.ts');

    expect(publicAgent).toContain('export interface AgentOptions');
    expect(internalAgent).toContain('export interface AgentRuntimeOptions');
    expect(internalAgent).not.toContain('export interface AgentOptions');
  });

  it('keeps internal runtime types out of package entrypoints', () => {
    for (const entrypoint of ['src/index.ts', 'src/browser/index.ts', 'src/advanced/index.ts']) {
      const entry = source(entrypoint);
      expect(entry).not.toMatch(/\bAgentRuntimeOptions\b/);
      expect(entry).not.toMatch(/\bAgentExecutionContext\b/);
    }
  });

  it('composes the internal execution context from narrow capability contracts', () => {
    const internalAgent = source('src/agent/types.ts');

    expect(internalAgent).toContain('export interface AgentConversationState');
    expect(internalAgent).toContain('export interface AgentExecutionControl');
    expect(internalAgent).toContain('export interface AgentExecutionServices');
    expect(internalAgent).toContain('export type AgentExecutionContext =');
    expect(internalAgent).not.toMatch(/\bChatContext\b/);
  });

  it('owns wire-safe user input outside internal Agent runtime types', () => {
    const userInput = source('src/agent/UserMessageContent.ts');
    const internalAgent = source('src/agent/types.ts');
    const protocol = source('src/protocol/types.ts');

    expect(userInput).toContain('export type UserMessageContent');
    expect(internalAgent).not.toContain('export type UserMessageContent');
    expect(protocol).toContain("from '../agent/UserMessageContent.js'");
  });
});
