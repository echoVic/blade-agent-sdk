import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import matter from 'gray-matter';
import writeFileAtomic from 'write-file-atomic';
import type { MemoryStore } from './MemoryStore.js';
import type { Memory, MemoryInput, MemoryType } from './types.js';

const INDEX_FILE = 'MEMORY.md';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

type MemoryIndexEntry = {
  title: string;
  filePath: string;
  hook: string;
};

/**
 * File-backed memory store.
 *
 * The individual memory files are the authority: each carries its own
 * frontmatter, and `MEMORY.md` is a derived index rebuilt from them. That is what
 * makes a save unable to lose another memory, and a lost or corrupted index cost
 * nothing.
 *
 * Writes are serialised per store instance, so two concurrent saves cannot
 * interleave a read-modify-write of the index.
 */
export class FileSystemMemoryStore implements MemoryStore {
  private readonly mutex = new Mutex();

  constructor(private readonly dir = path.join(os.homedir(), '.blade', 'memory')) {}

  async save(memory: MemoryInput): Promise<Memory> {
    this.ensureSlug(memory.name);
    const filename = this.nameToFilename(memory.name);
    const contentPath = path.join(this.dir, filename);

    return this.mutex.runExclusive(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(
        contentPath,
        matter.stringify(memory.body, {
          name: memory.name,
          description: memory.description,
          type: memory.type,
        }),
        { encoding: 'utf8' },
      );

      const entries = (await this.collectIndexEntries())
        .filter((entry) => entry.filePath !== filename);
      entries.push({ title: memory.name, filePath: filename, hook: memory.description });
      await this.writeIndex(entries);

      return { ...memory, updatedAt: await this.readUpdatedAt(contentPath) };
    });
  }

  /**
   * Returns undefined only when the memory does not exist. A storage failure is
   * raised instead of being reported as absence, which would hide unreadable or
   * corrupt files behind a "not found".
   */
  async get(name: string): Promise<Memory | undefined> {
    this.ensureSlug(name);
    const contentPath = path.join(this.dir, this.nameToFilename(name));

    let raw: string;
    try {
      raw = await readFile(contentPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    const memory = this.parseMemory(raw);
    if (!memory) {
      throw new Error(`Memory file ${contentPath} has no valid frontmatter`);
    }
    return { ...memory, updatedAt: await this.readUpdatedAt(contentPath) };
  }

  /**
   * Reads the memories that exist rather than the ones an index remembers, so a
   * lost index entry cannot make a stored memory invisible.
   */
  async list(): Promise<Memory[]> {
    const files = await this.listMemoryFiles();
    const memories = await Promise.all(files.map(async (filename) => {
      const contentPath = path.join(this.dir, filename);
      const memory = this.parseMemory(await readFile(contentPath, 'utf8'));
      if (!memory) {
        throw new Error(`Memory file ${contentPath} has no valid frontmatter`);
      }
      return { ...memory, updatedAt: await this.readUpdatedAt(contentPath) };
    }));
    return memories.sort((left, right) => left.name.localeCompare(right.name));
  }

  async delete(name: string): Promise<void> {
    this.ensureSlug(name);
    const filename = this.nameToFilename(name);

    await this.mutex.runExclusive(async () => {
      try {
        await unlink(path.join(this.dir, filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      // Rebuilt from the files rather than patched, for the same reason as save.
      await this.writeIndex(await this.collectIndexEntries());
    });
  }

  /**
   * Rewrites `MEMORY.md` from the memory files. Call it after an external change
   * to the directory or when the index is suspected to be stale.
   */
  async rebuildIndex(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.writeIndex(await this.collectIndexEntries());
    });
  }

  /** The index entries currently on disk, for callers that render or audit it. */
  async readIndexEntries(): Promise<readonly MemoryIndexEntry[]> {
    return this.readIndex();
  }

  private parseMemory(raw: string): Omit<Memory, 'updatedAt'> | undefined {
    const parsed = matter(raw);
    const frontmatter = parsed.data as {
      name?: unknown;
      description?: unknown;
      type?: unknown;
    };
    if (
      typeof frontmatter.name !== 'string'
      || typeof frontmatter.description !== 'string'
      || !MEMORY_TYPES.includes(frontmatter.type as MemoryType)
    ) {
      return undefined;
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type as MemoryType,
      body: parsed.content.trim(),
    };
  }

  /** Modification time is the real update time; a read cannot invent one. */
  private async readUpdatedAt(contentPath: string): Promise<number> {
    return (await stat(contentPath)).mtimeMs;
  }

  private async listMemoryFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return names.filter((name) => name.endsWith('.md') && name !== INDEX_FILE).sort();
  }

  /** The index entries the memory files imply, whatever the index currently says. */
  private async collectIndexEntries(): Promise<MemoryIndexEntry[]> {
    const files = await this.listMemoryFiles();
    const entries: MemoryIndexEntry[] = [];
    for (const filename of files) {
      const memory = this.parseMemory(await readFile(path.join(this.dir, filename), 'utf8'));
      if (memory) {
        entries.push({ title: memory.name, filePath: filename, hook: memory.description });
      }
    }
    return entries.sort((left, right) => left.filePath.localeCompare(right.filePath));
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
      // A missing or unreadable index is not an error: it is derived data.
      return [];
    }
  }

  private async writeIndex(entries: MemoryIndexEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const lines = entries.map((entry) => `- [${entry.title}](${entry.filePath}) — ${entry.hook}`);
    await writeFileAtomic(path.join(this.dir, INDEX_FILE), `${lines.join('\n')}\n`, {
      encoding: 'utf8',
    });
  }

  private nameToFilename(name: string): string {
    return `${name}.md`;
  }

  private ensureSlug(name: string): void {
    if (!SLUG_PATTERN.test(name)) {
      throw new Error(
        `Memory name "${name}" must be a lowercase slug (a-z0-9 and hyphen) without spaces`,
      );
    }
  }
}
