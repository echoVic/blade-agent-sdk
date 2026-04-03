import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { Memory, MemoryInput } from './MemoryTypes.js';
import type { MemoryStore } from './MemoryStore.js';

const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_LINES = 200;

export type MemoryIndexEntry = {
  title: string;
  filePath: string;
  hook: string;
};

export class FileSystemMemoryStore implements MemoryStore {
  constructor(private readonly dir = path.join(os.homedir(), '.blade', 'memory')) {}

  async save(memory: MemoryInput): Promise<Memory> {
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
      'utf8'
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
    const contentPath = path.join(this.dir, this.nameToFilename(name));

    try {
      const raw = await readFile(contentPath, 'utf8');
      const parsed = matter(raw);
      const fm = parsed.data as {
        name?: string;
        description?: string;
        type?: Memory['type'];
      };

      if (!fm.name || !fm.description || !fm.type) {
        return undefined;
      }

      return {
        name: fm.name,
        description: fm.description,
        type: fm.type,
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
      entries.map((entry) => this.get(path.basename(entry.filePath, '.md')))
    );
    return memories.filter((memory): memory is Memory => memory !== undefined);
  }

  async delete(name: string): Promise<void> {
    const filename = this.nameToFilename(name);

    try {
      await unlink(path.join(this.dir, filename));
    } catch {}

    const entries = await this.readIndex();
    await this.writeIndex(entries.filter((entry) => entry.filePath !== filename));
  }

  private async readIndex(): Promise<MemoryIndexEntry[]> {
    try {
      const raw = await readFile(path.join(this.dir, INDEX_FILE), 'utf8');
      return raw
        .split('\n')
        .map((line) => line.match(/^- \[(.+?)\]\((.+?)\)\s*[—–-]\s*(.+)$/))
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
    const lines = entries
      .slice(0, MAX_INDEX_LINES)
      .map((entry) => `- [${entry.title}](${entry.filePath}) — ${entry.hook}`);
    await writeFile(path.join(this.dir, INDEX_FILE), `${lines.join('\n')}\n`, 'utf8');
  }

  private nameToFilename(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') + '.md'
    );
  }
}
