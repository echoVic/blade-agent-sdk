import { describe, expect, it, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSkillMetadata, loadSkillContent, hasSkillFile } from '../SkillLoader.js';

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
    });

    it('should parse string boolean values (yes/no)', async () => {
      const filePath = await createSkillFile(tmpDir, VALID_SKILL_STRING_BOOLEANS);
      const result = await loadSkillMetadata(filePath, 'project');

      expect(result.success).toBe(true);
      expect(result.content!.metadata.userInvocable).toBe(true);
      expect(result.content!.metadata.disableModelInvocation).toBe(false);
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
});
