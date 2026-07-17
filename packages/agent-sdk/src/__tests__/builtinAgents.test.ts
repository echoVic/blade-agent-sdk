import { describe, expect, it } from 'vitest';
import { builtinAgents } from '../subagents/index.js';

describe('builtinAgents', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(builtinAgents)).toBe(true);
    expect(builtinAgents.length).toBeGreaterThan(0);
  });

  it('every agent has required name and description', () => {
    for (const agent of builtinAgents) {
      expect(typeof agent.name).toBe('string');
      expect(agent.name.length).toBeGreaterThan(0);
      expect(typeof agent.description).toBe('string');
      expect(agent.description.length).toBeGreaterThan(0);
    }
  });

  it('includes the general-purpose agent', () => {
    const gp = builtinAgents.find((a) => a.name === 'general-purpose');
    expect(gp).toBeDefined();
    expect(gp!.description).toContain('General-purpose');
  });

  it('includes the Explore agent', () => {
    const explore = builtinAgents.find((a) => a.name === 'Explore');
    expect(explore).toBeDefined();
    expect(explore!.tools).toEqual(['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']);
    expect(explore!.omitEnvironment).toBe(true);
  });

  it('includes the Plan agent', () => {
    const plan = builtinAgents.find((a) => a.name === 'Plan');
    expect(plan).toBeDefined();
    expect(plan!.description).toContain('architect');
  });

  it('Explore agent has a systemPrompt', () => {
    const explore = builtinAgents.find((a) => a.name === 'Explore');
    expect(explore).toBeDefined();
    expect(typeof explore!.systemPrompt).toBe('string');
    expect(explore!.systemPrompt!.length).toBeGreaterThan(100);
  });
});
