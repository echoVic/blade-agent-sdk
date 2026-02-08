import { describe, expect, it } from 'bun:test';
import { Matcher } from '../Matcher.js';
import type { MatchContext, MatcherConfig } from '../types/HookTypes.js';

describe('Matcher', () => {
  const matcher = new Matcher();

  describe('matches', () => {
    it('should match all when no config provided', () => {
      const context: MatchContext = { toolName: 'Bash' };
      expect(matcher.matches(undefined, context)).toBe(true);
    });

    it('should match all when config is empty', () => {
      const context: MatchContext = { toolName: 'Bash' };
      expect(matcher.matches({}, context)).toBe(true);
    });
  });

  describe('tool matching', () => {
    it('should match exact tool name', () => {
      const config: MatcherConfig = { tools: 'Bash' };
      expect(matcher.matches(config, { toolName: 'Bash' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Read' })).toBe(false);
    });

    it('should match pipe-separated tools', () => {
      const config: MatcherConfig = { tools: 'Edit|Write|Delete' };
      expect(matcher.matches(config, { toolName: 'Edit' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Write' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Delete' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Read' })).toBe(false);
    });

    it('should match wildcard', () => {
      const config: MatcherConfig = { tools: '*' };
      expect(matcher.matches(config, { toolName: 'Bash' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Read' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'AnyTool' })).toBe(true);
    });

    it('should match regex pattern', () => {
      const config: MatcherConfig = { tools: '.*Tool$' };
      expect(matcher.matches(config, { toolName: 'BashTool' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'ReadTool' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Bash' })).toBe(false);
    });

    it('should match tool array', () => {
      const config: MatcherConfig = { tools: ['Bash', 'Read', 'Write'] };
      expect(matcher.matches(config, { toolName: 'Bash' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Read' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Write' })).toBe(true);
      expect(matcher.matches(config, { toolName: 'Edit' })).toBe(false);
    });
  });

  describe('tool with parameter pattern', () => {
    it('should match Bash with command pattern', () => {
      const config: MatcherConfig = { tools: 'Bash(npm test*)' };
      expect(
        matcher.matches(config, { toolName: 'Bash', command: 'npm test' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Bash', command: 'npm test:unit' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Bash', command: 'npm install' })
      ).toBe(false);
    });

    it('should match Read with file pattern', () => {
      const config: MatcherConfig = { tools: 'Read(*.ts)' };
      expect(
        matcher.matches(config, { toolName: 'Read', filePath: 'index.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Read', filePath: 'src/main.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Read', filePath: 'index.js' })
      ).toBe(false);
    });

    it('should match Edit|Write with path pattern', () => {
      const config: MatcherConfig = { tools: 'Edit|Write(src/**)' };
      expect(
        matcher.matches(config, { toolName: 'Edit', filePath: 'src/index.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Write', filePath: 'src/utils/helper.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Edit', filePath: 'test/index.ts' })
      ).toBe(false);
    });
  });

  describe('path matching', () => {
    it('should match glob pattern', () => {
      const config: MatcherConfig = { paths: '**/*.ts' };
      expect(matcher.matches(config, { filePath: 'src/index.ts' })).toBe(true);
      expect(matcher.matches(config, { filePath: 'test/main.ts' })).toBe(true);
      expect(matcher.matches(config, { filePath: 'index.js' })).toBe(false);
    });

    it('should match path array', () => {
      const config: MatcherConfig = { paths: ['src/**', 'lib/**'] };
      expect(matcher.matches(config, { filePath: 'src/index.ts' })).toBe(true);
      expect(matcher.matches(config, { filePath: 'lib/utils.ts' })).toBe(true);
      expect(matcher.matches(config, { filePath: 'test/main.ts' })).toBe(false);
    });
  });

  describe('command matching', () => {
    it('should match exact command', () => {
      const config: MatcherConfig = { commands: 'npm test' };
      expect(matcher.matches(config, { command: 'npm test' })).toBe(true);
      expect(matcher.matches(config, { command: 'npm install' })).toBe(false);
    });

    it('should match command pattern', () => {
      const config: MatcherConfig = { commands: 'npm *' };
      expect(matcher.matches(config, { command: 'npm test' })).toBe(true);
      expect(matcher.matches(config, { command: 'npm install' })).toBe(true);
      expect(matcher.matches(config, { command: 'yarn test' })).toBe(false);
    });

    it('should match command array', () => {
      const config: MatcherConfig = { commands: ['npm test', 'npm run build'] };
      expect(matcher.matches(config, { command: 'npm test' })).toBe(true);
      expect(matcher.matches(config, { command: 'npm run build' })).toBe(true);
      expect(matcher.matches(config, { command: 'npm install' })).toBe(false);
    });
  });

  describe('combined matching', () => {
    it('should require all conditions to match', () => {
      const config: MatcherConfig = {
        tools: 'Bash',
        commands: 'npm *',
      };
      expect(
        matcher.matches(config, { toolName: 'Bash', command: 'npm test' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Bash', command: 'yarn test' })
      ).toBe(false);
      expect(
        matcher.matches(config, { toolName: 'Read', command: 'npm test' })
      ).toBe(false);
    });

    it('should match tool and path together', () => {
      const config: MatcherConfig = {
        tools: 'Edit|Write',
        paths: 'src/**/*.ts',
      };
      expect(
        matcher.matches(config, { toolName: 'Edit', filePath: 'src/index.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Write', filePath: 'src/utils/helper.ts' })
      ).toBe(true);
      expect(
        matcher.matches(config, { toolName: 'Edit', filePath: 'test/index.ts' })
      ).toBe(false);
      expect(
        matcher.matches(config, { toolName: 'Read', filePath: 'src/index.ts' })
      ).toBe(false);
    });
  });
});
