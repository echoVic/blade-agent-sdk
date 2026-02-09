import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandParser } from '../CommandParser.js';

describe('CommandParser', () => {
  let parser: CommandParser;
  let tmpDir: string;

  beforeEach(() => {
    parser = new CommandParser();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-parser-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: write a markdown command file and return its absolute path.
   */
  function writeCommandFile(
    relativePath: string,
    content: string
  ): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // parse – basic behaviour
  // ---------------------------------------------------------------------------
  describe('parse', () => {
    it('should parse a simple markdown command file', () => {
      const filePath = writeCommandFile(
        'hello.md',
        '---\ndescription: Say hello\n---\nHello, world!'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('hello');
      expect(result!.content).toBe('Hello, world!');
      expect(result!.source).toBe('project');
      expect(result!.sourceDir).toBe('blade');
      expect(result!.path).toBe(filePath);
      expect(result!.config.description).toBe('Say hello');
    });

    it('should parse a file without frontmatter', () => {
      const filePath = writeCommandFile('plain.md', 'Just plain content');

      const result = parser.parse(filePath, tmpDir, 'user', 'claude');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('plain');
      expect(result!.content).toBe('Just plain content');
      expect(result!.config.description).toBeUndefined();
    });

    it('should trim the body content', () => {
      const filePath = writeCommandFile(
        'trimmed.md',
        '---\ndescription: test\n---\n\n  Some content with whitespace  \n\n'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result).not.toBeNull();
      expect(result!.content).toBe('Some content with whitespace');
    });

    it('should return null for a non-existent file', () => {
      const result = parser.parse(
        path.join(tmpDir, 'does-not-exist.md'),
        tmpDir,
        'project',
        'blade'
      );

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // parse – name and namespace extraction
  // ---------------------------------------------------------------------------
  describe('name and namespace extraction', () => {
    it('should strip the .md extension from the file name', () => {
      const filePath = writeCommandFile('deploy.md', 'Deploy command');

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.name).toBe('deploy');
    });

    it('should strip .MD extension case-insensitively', () => {
      const filePath = writeCommandFile('UPPER.MD', 'Upper case extension');

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.name).toBe('UPPER');
    });

    it('should set namespace from subdirectory path', () => {
      const filePath = writeCommandFile('git/commit.md', 'Git commit helper');

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.name).toBe('commit');
      expect(result!.namespace).toBe('git');
    });

    it('should join nested subdirectories with / for namespace', () => {
      const filePath = writeCommandFile(
        'tools/docker/build.md',
        'Docker build'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.name).toBe('build');
      expect(result!.namespace).toBe('tools/docker');
    });

    it('should have undefined namespace for root-level files', () => {
      const filePath = writeCommandFile('root-cmd.md', 'Root command');

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.namespace).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // parse – config normalisation (frontmatter)
  // ---------------------------------------------------------------------------
  describe('config normalisation', () => {
    it('should parse description from frontmatter', () => {
      const filePath = writeCommandFile(
        'desc.md',
        '---\ndescription: A useful command\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.description).toBe('A useful command');
    });

    it('should parse argument-hint from frontmatter', () => {
      const filePath = writeCommandFile(
        'hint.md',
        '---\nargument-hint: "<file-path>"\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.argumentHint).toBe('<file-path>');
    });

    it('should parse model from frontmatter', () => {
      const filePath = writeCommandFile(
        'model.md',
        '---\nmodel: claude-opus-4-6\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.model).toBe('claude-opus-4-6');
    });

    it('should parse disable-model-invocation as boolean', () => {
      const filePath = writeCommandFile(
        'no-invoke.md',
        '---\ndisable-model-invocation: true\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.disableModelInvocation).toBe(true);
    });

    it('should default disableModelInvocation to undefined when not set', () => {
      const filePath = writeCommandFile(
        'default.md',
        '---\ndescription: test\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      // data['disable-model-invocation'] is undefined, so !== true → falsy
      expect(result!.config.disableModelInvocation).toBeFalsy();
    });

    it('should parse allowed-tools as an array', () => {
      const filePath = writeCommandFile(
        'tools-array.md',
        '---\nallowed-tools:\n  - Bash\n  - Read\n  - Write\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.allowedTools).toEqual(['Bash', 'Read', 'Write']);
    });

    it('should parse allowed-tools as a comma-separated string', () => {
      const filePath = writeCommandFile(
        'tools-string.md',
        '---\nallowed-tools: "Bash, Read, Write"\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.allowedTools).toEqual(['Bash', 'Read', 'Write']);
    });

    it('should return undefined for allowed-tools when not provided', () => {
      const filePath = writeCommandFile(
        'no-tools.md',
        '---\ndescription: test\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.allowedTools).toBeUndefined();
    });

    it('should return undefined for empty string values', () => {
      const filePath = writeCommandFile(
        'empty.md',
        '---\ndescription: ""\nargument-hint: "   "\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.description).toBeUndefined();
      expect(result!.config.argumentHint).toBeUndefined();
    });

    it('should trim string config values', () => {
      const filePath = writeCommandFile(
        'whitespace.md',
        '---\ndescription: "  padded description  "\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.description).toBe('padded description');
    });

    it('should filter empty entries from allowed-tools array', () => {
      const filePath = writeCommandFile(
        'tools-filter.md',
        '---\nallowed-tools:\n  - Bash\n  - ""\n  - Read\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.allowedTools).toEqual(['Bash', 'Read']);
    });

    it('should filter empty entries from comma-separated allowed-tools', () => {
      const filePath = writeCommandFile(
        'tools-comma-filter.md',
        '---\nallowed-tools: "Bash,, ,Read"\n---\nbody'
      );

      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result!.config.allowedTools).toEqual(['Bash', 'Read']);
    });
  });

  // ---------------------------------------------------------------------------
  // parse – full frontmatter round-trip
  // ---------------------------------------------------------------------------
  describe('full frontmatter round-trip', () => {
    it('should parse all config fields together', () => {
      const content = [
        '---',
        'description: Run tests',
        'argument-hint: "<test-pattern>"',
        'model: claude-opus-4-6',
        'disable-model-invocation: true',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        '---',
        'Run the test suite with $ARGUMENTS',
      ].join('\n');

      const filePath = writeCommandFile('test-runner.md', content);
      const result = parser.parse(filePath, tmpDir, 'project', 'blade');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('test-runner');
      expect(result!.config).toEqual({
        description: 'Run tests',
        argumentHint: '<test-pattern>',
        model: 'claude-opus-4-6',
        disableModelInvocation: true,
        allowedTools: ['Bash', 'Read'],
      });
      expect(result!.content).toBe('Run the test suite with $ARGUMENTS');
    });
  });

  // ---------------------------------------------------------------------------
  // validateConfig
  // ---------------------------------------------------------------------------
  describe('validateConfig', () => {
    it('should return no errors for a valid config', () => {
      const errors = parser.validateConfig({
        description: 'Valid command',
        model: 'claude-opus-4-6',
      });

      expect(errors).toEqual([]);
    });

    it('should return no errors when model is not set', () => {
      const errors = parser.validateConfig({
        description: 'No model',
      });

      expect(errors).toEqual([]);
    });

    it('should return no error for an empty model string (falsy, skipped)', () => {
      const errors = parser.validateConfig({
        model: '',
      });

      // Empty string is falsy, so the model check is skipped
      expect(errors.length).toBe(0);
    });

    it('should return an error for an excessively long model string', () => {
      const errors = parser.validateConfig({
        model: 'x'.repeat(200),
      });

      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('Invalid model ID');
    });

    it('should accept a model string of length 199', () => {
      const errors = parser.validateConfig({
        model: 'x'.repeat(199),
      });

      expect(errors).toEqual([]);
    });

    it('should return no errors for a config with no optional fields', () => {
      const errors = parser.validateConfig({});

      expect(errors).toEqual([]);
    });
  });
});
