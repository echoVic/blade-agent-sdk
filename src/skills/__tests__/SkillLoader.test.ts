import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverSkillScripts,
  hasSkillFile,
  loadSkillContent,
  loadSkillMetadata,
  processInlineCommands
} from '../SkillLoader.js';

// ===== Helper =====

let tmpDir: string;

async function createSkillFile(dir: string, content: string): Promise<string> {
  const skillDir = path.join(dir, 'test-skill');
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

const VALID_SKILL = `---
name: test-skill
description: A test skill for unit testing
allowed-tools:
  - Read
  - Grep
version: "1.0.0"
---

# Test Skill

This is the instruction content.
`;

const VALID_SKILL_COMMA_TOOLS = `---
name: comma-tools
description: Skill with comma-separated tools
allowed-tools: "Read, Grep, Glob"
---

Instructions here.
`;

const VALID_SKILL_SPACE_TOOLS = `---
name: space-tools
description: Skill with space-separated tools (agentskills.io format)
allowed-tools: "Bash(git:*) Read Grep"
---

Instructions here.
`;

const VALID_SKILL_BOOLEANS = `---
name: bool-skill
description: Skill with boolean fields
user-invocable: true
disable-model-invocation: false
argument-hint: "<file_path>"
model: gpt-4
when_to_use: When the user asks about files
---

Do file things.
`;

const VALID_SKILL_STRING_BOOLEANS = `---
name: str-bool-skill
description: Skill with string boolean fields
user-invocable: "yes"
disable-model-invocation: "no"
---

Content.
`;

const VALID_SKILL_NEW_FIELDS = `---
name: licensed-skill
description: Skill with license and compatibility fields
license: Apache-2.0
compatibility: Requires git, python3 and network access
metadata:
  author: my-org
  version: "1.2"
  tags:
    - code-review
    - git
---

Instructions here.
`;

const INVALID_NO_FRONTMATTER = `# Just Markdown

No YAML frontmatter here.
`;

const INVALID_NO_NAME = `---
description: Missing name field
---

Content.
`;

const INVALID_NO_DESCRIPTION = `---
name: no-desc
---

Content.
`;

const INVALID_NAME_FORMAT = `---
name: Invalid_Name_123
description: Bad name format
---

Content.
`;

const INVALID_YAML = `---
name: bad-yaml
description: [unclosed bracket
---

Content.
`;

// ===== Tests =====

describe('SkillLoader', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
  });

  describe('loadSkillMetadata', () => {
    it('should parse valid SKILL.md with all fields', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content!.metadata.name).toBe('test-skill');
      expect(result.content!.metadata.description).toBe('A test skill for unit testing');
      expect(result.content!.metadata.allowedTools).toEqual(['Read', 'Grep']);
      expect(result.content!.metadata.runtimeEffects).toEqual({
        allowedTools: ['Read', 'Grep'],
        modelId: undefined,
      });
      expect(result.content!.metadata.version).toBe('1.0.0');
      expect(result.content!.metadata.source).toBe('project');
      expect(result.content!.metadata.path).toBe(filePath);
      expect(result.content!.instructions).toBe('# Test Skill\n\nThis is the instruction content.');
    });

    it('should parse comma-separated allowed-tools', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_COMMA_TOOLS);
      const result = await loadSkillMetadata(filePath, 'user');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    });

    it('should parse space-separated allowed-tools (agentskills.io format)', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_SPACE_TOOLS);
      const result = await loadSkillMetadata(filePath, 'user');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.allowedTools).toEqual(['Bash(git:*)', 'Read', 'Grep']);
    });

    it('should parse boolean fields correctly', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_BOOLEANS);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      const meta = result.content!.metadata;
      expect(meta.userInvocable).toBe(true);
      expect(meta.disableModelInvocation).toBe(false);
      expect(meta.argumentHint).toBe('<file_path>');
      expect(meta.model).toBe('gpt-4');
      expect(meta.whenToUse).toBe('When the user asks about files');
      expect(meta.runtimeEffects).toEqual({
        allowedTools: undefined,
        modelId: 'gpt-4',
      });
    });

    it('should parse string boolean values (yes/no)', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_STRING_BOOLEANS);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.userInvocable).toBe(true);
      expect(result.content!.metadata.disableModelInvocation).toBe(false);
    });

    it('should parse license, compatibility, and metadata fields', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_NEW_FIELDS);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      const meta = result.content!.metadata;
      expect(meta.license).toBe('Apache-2.0');
      expect(meta.compatibility).toBe('Requires git, python3 and network access');
      expect(meta.metadata).toEqual({
        author: 'my-org',
        version: '1.2',
        tags: ['code-review', 'git'],
      });
    });

    it('should not set license/compatibility/metadata when absent', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.license).toBeUndefined();
      expect(result.content!.metadata.compatibility).toBeUndefined();
      expect(result.content!.metadata.metadata).toBeUndefined();
    });

    it('should fail on missing frontmatter', async () => {
      const filePath = await createSkillFile(tmpDir, INVALID_NO_FRONTMATTER);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing YAML frontmatter');
    });

    it('should fail on missing name', async () => {
      const filePath = await createSkillFile(tmpDir, INVALID_NO_NAME);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should fail on missing description', async () => {
      const filePath = await createSkillFile(tmpDir, INVALID_NO_DESCRIPTION);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('description');
    });

    it('should fail on invalid name format', async () => {
      const filePath = await createSkillFile(tmpDir, INVALID_NAME_FORMAT);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid name');
    });

    it('should fail on invalid YAML', async () => {
      const filePath = await createSkillFile(tmpDir, INVALID_YAML);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('parse YAML');
    });

    it('should fail on non-existent file', async () => {
      const result = await loadSkillMetadata('/nonexistent/SKILL.md', 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should set basePath to directory of SKILL.md', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.basePath).toBe(path.dirname(filePath));
    });
  });

  describe('loadSkillContent', () => {
    it('should load full content from metadata', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      const content = await loadSkillContent(metaResult.content!.metadata);
      expect(content).not.toBeNull();
      expect(content!.metadata.name).toBe('test-skill');
      expect(content!.instructions).toContain('Test Skill');
    });

    it('should return null for deleted file', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      await fs.unlink(filePath);
      const content = await loadSkillContent(metaResult.content!.metadata);
      expect(content).toBeNull();
    });

    it('should process inline commands when cwd is provided', async () => {
      const skillContent = `---
name: inline-skill
description: Skill with inline commands
---

Hello !{ECHO_CMD}World
`;
      // Use a skill with echo command
      const skillWithEcho = skillContent.replace('!{ECHO_CMD}', '!`echo -n ""`');
      const filePath = await createSkillFile(tmpDir, skillWithEcho);
      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      const content = await loadSkillContent(metaResult.content!.metadata, { cwd: tmpDir });
      expect(content).not.toBeNull();
      // echo -n "" returns empty string, so "(unavailable)" would not appear
      // The inline command replaces with output (empty string from echo -n "")
      expect(content!.instructions).toContain('Hello ');
    });

    it('should not process inline commands when cwd is not provided', async () => {
      const skillWithCmd = `---
name: cmd-skill
description: Skill with inline command
---

Result: !` + '`echo hello`' + `
`;
      const filePath = await createSkillFile(tmpDir, skillWithCmd);
      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      // No cwd provided → inline commands should not be processed
      const content = await loadSkillContent(metaResult.content!.metadata);
      expect(content).not.toBeNull();
      expect(content!.instructions).toContain('!`echo hello`');
    });

    it('should discover scripts in scripts/ directory', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const skillDir = path.dirname(filePath);
      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'setup.sh'), '#!/bin/bash\necho setup');
      await fs.writeFile(path.join(scriptsDir, 'analyze.py'), 'print("analyze")');

      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      const content = await loadSkillContent(metaResult.content!.metadata);
      expect(content).not.toBeNull();
      expect(content!.scripts).toEqual(['scripts/analyze.py', 'scripts/setup.sh']);
    });

    it('should return empty scripts when no scripts/ directory exists', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL);
      const metaResult = await loadSkillMetadata(filePath, 'project');
      expect(metaResult.success).toBe(true);

      const content = await loadSkillContent(metaResult.content!.metadata);
      expect(content).not.toBeNull();
      expect(content!.scripts).toEqual([]);
    });
  });

  describe('hasSkillFile', () => {
    it('should return true when SKILL.md exists', async () => {
      const skillDir = path.join(tmpDir, 'has-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), VALID_SKILL);

      expect(await hasSkillFile(skillDir)).toBe(true);
    });

    it('should return false when SKILL.md does not exist', async () => {
      const emptyDir = path.join(tmpDir, 'empty');
      await fs.mkdir(emptyDir, { recursive: true });

      expect(await hasSkillFile(emptyDir)).toBe(false);
    });

    it('should return false for non-existent directory', async () => {
      expect(await hasSkillFile('/nonexistent/dir')).toBe(false);
    });
  });

  describe('discoverSkillScripts', () => {
    it('should list script files sorted alphabetically', async () => {
      const skillDir = path.join(tmpDir, 'script-skill');
      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'zebra.sh'), '');
      await fs.writeFile(path.join(scriptsDir, 'alpha.py'), '');
      await fs.writeFile(path.join(scriptsDir, 'beta.ts'), '');

      const scripts = await discoverSkillScripts(skillDir);
      expect(scripts).toEqual(['scripts/alpha.py', 'scripts/beta.ts', 'scripts/zebra.sh']);
    });

    it('should ignore subdirectories inside scripts/', async () => {
      const skillDir = path.join(tmpDir, 'nested-skill');
      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(path.join(scriptsDir, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'run.sh'), '');

      const scripts = await discoverSkillScripts(skillDir);
      expect(scripts).toEqual(['scripts/run.sh']);
    });

    it('should return empty array when scripts/ does not exist', async () => {
      const skillDir = path.join(tmpDir, 'no-scripts');
      await fs.mkdir(skillDir, { recursive: true });

      const scripts = await discoverSkillScripts(skillDir);
      expect(scripts).toEqual([]);
    });

    it('should return empty array for empty scripts/ directory', async () => {
      const skillDir = path.join(tmpDir, 'empty-scripts');
      await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });

      const scripts = await discoverSkillScripts(skillDir);
      expect(scripts).toEqual([]);
    });
  });

  describe('processInlineCommands', () => {
    it('should replace !`echo hello` with command output', async () => {
      const content = 'Result: !`echo hello`';
      const result = await processInlineCommands(content, tmpDir);
      expect(result).toBe('Result: hello');
    });

    it('should return cwd from !`pwd`', async () => {
      const content = 'Path: !`pwd`';
      const result = await processInlineCommands(content, tmpDir);
      // pwd returns the real path (resolving symlinks), so compare with fs.realpath
      const realTmpDir = await fs.realpath(tmpDir);
      expect(result).toBe(`Path: ${realTmpDir}`);
    });

    it('should return content unchanged when no inline commands present', async () => {
      const content = 'No commands here, just text.';
      const result = await processInlineCommands(content, tmpDir);
      expect(result).toBe(content);
    });

    it('should replace multiple inline commands in correct order', async () => {
      const content = 'A: !`echo first` B: !`echo second`';
      const result = await processInlineCommands(content, tmpDir);
      expect(result).toBe('A: first B: second');
    });

    it('should return (unavailable) for failing commands', async () => {
      const warnMessages: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnMessages.push(msg),
      };
      const content = 'Value: !`exit 1`';
      const result = await processInlineCommands(content, tmpDir, { logger });
      expect(result).toBe('Value: (unavailable)');
      expect(warnMessages.some((m) => m.includes('非零退出'))).toBe(true);
    });

    it('should return (unavailable) for non-existent commands', async () => {
      const warnMessages: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnMessages.push(msg),
      };
      const content = 'Value: !`__nonexistent_command_xyz__`';
      const result = await processInlineCommands(content, tmpDir, { logger });
      expect(result).toBe('Value: (unavailable)');
      expect(warnMessages.length).toBeGreaterThan(0);
    });

    it('should log info for each executed command', async () => {
      const infoMessages: string[] = [];
      const logger = {
        info: (msg: string) => infoMessages.push(msg),
        warn: () => {},
      };
      const content = '!`echo test`';
      await processInlineCommands(content, tmpDir, { logger, skillName: 'test-skill' });
      expect(infoMessages.some((m) => m.includes('echo test') && m.includes('test-skill'))).toBe(true);
    });

    it('should block commands not in allowlist', async () => {
      const warnMessages: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnMessages.push(msg),
      };
      const content = 'Safe: !`git log` Unsafe: !`rm -rf /tmp/test`';
      const result = await processInlineCommands(content, tmpDir, {
        allowlist: ['git '],
        logger,
      });
      expect(result).toContain('(unavailable)');
      expect(warnMessages.some((m) => m.includes('拦截'))).toBe(true);
    });

    it('should block shell meta-char injection even with matching prefix', async () => {
      const warnMessages: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnMessages.push(msg),
      };
      const content = '!`git log; echo INJECTED`';
      const result = await processInlineCommands(content, tmpDir, {
        allowlist: ['git '],
        logger,
      });
      expect(result).toBe('(unavailable)');
      expect(warnMessages.some((m) => m.includes('元字符'))).toBe(true);
    });

    it('should block pipe injection even with matching prefix', async () => {
      const warnMessages: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnMessages.push(msg),
      };
      const content = '!`git log | cat /etc/passwd`';
      const result = await processInlineCommands(content, tmpDir, {
        allowlist: ['git '],
        logger,
      });
      expect(result).toBe('(unavailable)');
      expect(warnMessages.some((m) => m.includes('元字符'))).toBe(true);
    });

    it('should NOT execute commands inside fenced code blocks', async () => {
      const content = [
        'Normal: !`echo executed`',
        '',
        '```bash',
        'Example: !`echo not_executed`',
        '```',
      ].join('\n');

      const result = await processInlineCommands(content, tmpDir);

      expect(result).toContain('Normal: executed');
      expect(result).toContain('!`echo not_executed`');
    });

    it('should NOT execute commands inside indented fenced code blocks', async () => {
      const content = [
        'Normal: !`echo executed`',
        '',
        '  ```bash',
        '  Example: !`echo not_executed`',
        '  ```',
      ].join('\n');

      const result = await processInlineCommands(content, tmpDir);

      expect(result).toContain('Normal: executed');
      expect(result).toContain('!`echo not_executed`');
    });

    it('should NOT execute commands inside tilde fenced code blocks', async () => {
      const content = [
        'Normal: !`echo executed`',
        '',
        '~~~',
        'Example: !`echo not_executed`',
        '~~~',
      ].join('\n');

      const result = await processInlineCommands(content, tmpDir);

      expect(result).toContain('Normal: executed');
      expect(result).toContain('!`echo not_executed`');
    });

    it('should use allowlist: all (default) to allow all commands', async () => {
      const content = '!`echo allowed`';
      const result = await processInlineCommands(content, tmpDir, { allowlist: 'all' });
      expect(result).toBe('allowed');
    });

    it('should handle empty content gracefully', async () => {
      const result = await processInlineCommands('', tmpDir);
      expect(result).toBe('');
    });
  });
});
