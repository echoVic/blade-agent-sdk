import { describe, expect, it } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import { RuntimePatchManager } from '../RuntimePatchManager.js';

describe('createSkillActivationContext — system message filtering', () => {
  function createRPM() {
    return new RuntimePatchManager(undefined, NOOP_LOGGER);
  }

  const user = (content: string): Message => ({ role: 'user', content });
  const asst = (content: string): Message => ({ role: 'assistant', content });
  const sys = (content: string): Message => ({ role: 'system', content });

  it('excludes system messages from file reference analysis', () => {
    const rpm = createRPM();
    const messages: Message[] = [
      sys('You are a helpful assistant. File: /etc/passwd'),
      user('Please read /home/user/app.ts'),
      asst('I will read the file.'),
      sys('Available tools: Read, Write, Edit at /tools/catalog.json'),
    ];

    const ctx = rpm.createSkillActivationContext('/test', messages);

    // System messages should NOT contribute to referencedPaths
    // Only user/assistant content should be analyzed
    for (const path of ctx.referencedPaths ?? []) {
      expect(path).not.toContain('passwd');
      expect(path).not.toContain('catalog.json');
    }
  });

  it('still extracts paths from user and assistant messages', () => {
    const rpm = createRPM();
    const messages: Message[] = [
      user('Please edit /src/index.ts'),
      asst('I read /src/utils.ts and will update it.'),
    ];

    const ctx = rpm.createSkillActivationContext('/test', messages);
    const paths = ctx.referencedPaths ?? [];

    // Should find paths from user/assistant content
    expect(paths.some((p) => p.includes('index.ts') || p.includes('utils.ts'))).toBe(true);
  });

  it('returns empty paths when all messages are system', () => {
    const rpm = createRPM();
    const messages: Message[] = [
      sys('System prompt with /some/path.ts'),
      sys('Catalog at /tools/registry.json'),
    ];

    const ctx = rpm.createSkillActivationContext('/test', messages);
    // All messages filtered out, so no paths
    expect(ctx.referencedPaths).toEqual([]);
  });

  it('handles empty messages array', () => {
    const rpm = createRPM();
    const ctx = rpm.createSkillActivationContext('/test', []);
    expect(ctx.referencedPaths).toEqual([]);
  });

  it('preserves cwd in context', () => {
    const rpm = createRPM();
    const ctx = rpm.createSkillActivationContext('/my/project', []);
    expect(ctx.cwd).toBe('/my/project');
  });
});
