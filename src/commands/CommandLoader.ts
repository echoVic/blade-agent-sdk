import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandParser } from './CommandParser.js';
import type {
  CommandSearchDir,
  CustomCommand,
  CustomCommandDiscoveryResult,
} from './types.js';

export class CommandLoader {
  private parser = new CommandParser();

  async discover(workspaceRoot: string): Promise<CustomCommandDiscoveryResult> {
    const commands: CustomCommand[] = [];
    const scannedDirs: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    const searchDirs = this.getSearchDirs(workspaceRoot);

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir.path)) {
        continue;
      }

      scannedDirs.push(dir.path);

      try {
        const files = await this.scanDirectory(dir.path);

        for (const file of files) {
          try {
            const cmd = this.parser.parse(file, dir.path, dir.source, dir.sourceDir);
            if (cmd) {
              commands.push(cmd);
            }
          } catch (error) {
            errors.push({
              path: file,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        errors.push({
          path: dir.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { commands, scannedDirs, errors };
  }

  private getSearchDirs(workspaceRoot: string): CommandSearchDir[] {
    const homeDir = os.homedir();

    return [
      {
        path: path.join(homeDir, '.blade', 'commands'),
        source: 'user' as const,
        sourceDir: 'blade' as const,
      },
      {
        path: path.join(homeDir, '.claude', 'commands'),
        source: 'user' as const,
        sourceDir: 'claude' as const,
      },
      {
        path: path.join(workspaceRoot, '.blade', 'commands'),
        source: 'project' as const,
        sourceDir: 'blade' as const,
      },
      {
        path: path.join(workspaceRoot, '.claude', 'commands'),
        source: 'project' as const,
        sourceDir: 'claude' as const,
      },
    ];
  }

  private async scanDirectory(dirPath: string): Promise<string[]> {
    const results: string[] = [];

    const scan = async (currentPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    };

    await scan(dirPath);
    return results;
  }

  async hasCommands(workspaceRoot: string): Promise<boolean> {
    const searchDirs = this.getSearchDirs(workspaceRoot);

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir.path)) {
        continue;
      }

      const files = await this.scanDirectory(dir.path);
      if (files.length > 0) {
        return true;
      }
    }

    return false;
  }

  getCommandDirs(workspaceRoot: string): {
    projectBlade: string;
    projectClaude: string;
    userBlade: string;
    userClaude: string;
  } {
    const homeDir = os.homedir();

    return {
      projectBlade: path.join(workspaceRoot, '.blade', 'commands'),
      projectClaude: path.join(workspaceRoot, '.claude', 'commands'),
      userBlade: path.join(homeDir, '.blade', 'commands'),
      userClaude: path.join(homeDir, '.claude', 'commands'),
    };
  }
}
