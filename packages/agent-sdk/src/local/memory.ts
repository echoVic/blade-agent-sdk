import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { MemoryStore } from './MemoryStore.js';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  updatedAt: number;
}

export type { MemoryStore } from './MemoryStore.js';

const indexFile = 'MEMORY.md';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type MemoryIndexEntry = {
  title: string;
  filePath: string;
  hook: string;
};

export class FileSystemMemoryStore implements MemoryStore {
  constructor(private readonly dir = path.join(os.homedir(), '.blade', 'memory')) {}

  async save(memory: MemoryInput): Promise<Memory> {
    this.ensureSlug(memory.name);
    const filename = this.nameToFilename(memory.name);
    const contentPath = path.join(this.dir, filename);

    await mkdir(this.dir, { recursive: true });
    await writeFile(
      contentPath,
      matter.stringify(memory.body, {
        name: memory.name,
        description: memory.description,
        type: memory.type,
      }),
      'utf8',
    );

    const stored: Memory = {
      ...memory,
      updatedAt: Date.now(),
    };

    const entries = await this.readIndex();
    const next = [
      ...entries.filter((entry) => entry.filePath !== filename),
      {
        title: memory.name,
        filePath: filename,
        hook: memory.description,
      },
    ];

    await this.writeIndex(next);
    return stored;
  }

  async get(name: string): Promise<Memory | undefined> {
    this.ensureSlug(name);
    const contentPath = path.join(this.dir, this.nameToFilename(name));

    try {
      const raw = await readFile(contentPath, 'utf8');
      const parsed = matter(raw);
      const frontmatter = parsed.data as {
        name?: string;
        description?: string;
        type?: MemoryType;
      };

      if (!frontmatter.name || !frontmatter.description || !frontmatter.type) {
        return undefined;
      }

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        type: frontmatter.type,
        body: parsed.content.trim(),
        updatedAt: Date.now(),
      };
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Memory[]> {
    const entries = await this.readIndex();
    const memories = await Promise.all(
      entries.map((entry) => this.get(path.basename(entry.filePath, '.md'))),
    );
    return memories.filter((memory): memory is Memory => memory !== undefined);
  }

  async delete(name: string): Promise<void> {
    this.ensureSlug(name);
    const filename = this.nameToFilename(name);

    try {
      await unlink(path.join(this.dir, filename));
    } catch {}

    const entries = await this.readIndex();
    await this.writeIndex(entries.filter((entry) => entry.filePath !== filename));
  }

  private async readIndex(): Promise<MemoryIndexEntry[]> {
    try {
      const raw = await readFile(path.join(this.dir, indexFile), 'utf8');
      return raw
        .split('\n')
        .map((line) => line.match(/^- \[(.+?)\]\((.+?)\)\s*[-]\s*(.+)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => ({
          title: match[1],
          filePath: match[2],
          hook: match[3].trim(),
        }));
    } catch {
      return [];
    }
  }

  private async writeIndex(entries: MemoryIndexEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const lines = entries.map((entry) => `- [${entry.title}](${entry.filePath}) - ${entry.hook}`);
    await writeFile(path.join(this.dir, indexFile), `${lines.join('\n')}\n`, 'utf8');
  }

  private nameToFilename(name: string): string {
    return `${name}.md`;
  }

  private ensureSlug(name: string): void {
    if (!slugPattern.test(name)) {
      throw new Error(
        `Memory name "${name}" must be a lowercase slug (a-z0-9 and hyphen) without spaces`,
      );
    }
  }
}


