import { CommandExecutor } from './CommandExecutor.js';
import { CommandLoader } from './CommandLoader.js';
import type {
  CustomCommand,
  CustomCommandDiscoveryResult,
  CustomCommandExecutionContext,
} from './types.js';

export class CommandRegistry {
  private static instance: CommandRegistry;

  private commands: Map<string, CustomCommand> = new Map();
  private loader = new CommandLoader();
  private executor = new CommandExecutor();
  private initialized = false;
  private workspaceRoot = '';
  private lastDiscoveryResult: CustomCommandDiscoveryResult | null = null;

  static getInstance(): CommandRegistry {
    if (!CommandRegistry.instance) {
      CommandRegistry.instance = new CommandRegistry();
    }
    return CommandRegistry.instance;
  }

  static resetInstance(): void {
    CommandRegistry.instance = new CommandRegistry();
  }

  private constructor() {}

  async initialize(workspaceRoot: string): Promise<CustomCommandDiscoveryResult> {
    this.workspaceRoot = workspaceRoot;

    const result = await this.loader.discover(workspaceRoot);
    this.lastDiscoveryResult = result;

    this.commands.clear();

    for (const cmd of result.commands) {
      this.commands.set(cmd.name, cmd);
    }

    this.initialized = true;
    return result;
  }

  async refresh(): Promise<CustomCommandDiscoveryResult> {
    if (!this.workspaceRoot) {
      throw new Error('Registry not initialized. Call initialize() first.');
    }
    return this.initialize(this.workspaceRoot);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getCommand(name: string): CustomCommand | undefined {
    return this.commands.get(name);
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  getAllCommands(): CustomCommand[] {
    return Array.from(this.commands.values());
  }

  getCommandCount(): number {
    return this.commands.size;
  }

  getModelInvocableCommands(): CustomCommand[] {
    return this.getAllCommands().filter(
      (cmd) => cmd.config.description && !cmd.config.disableModelInvocation
    );
  }

  async executeCommand(
    name: string,
    context: CustomCommandExecutionContext
  ): Promise<string | null> {
    const cmd = this.getCommand(name);
    if (!cmd) {
      return null;
    }

    return this.executor.execute(cmd, context);
  }

  getCommandLabel(cmd: CustomCommand): string {
    const base = cmd.source === 'project' ? 'project' : 'user';
    if (cmd.namespace) {
      return `(${base}:${cmd.namespace})`;
    }
    return `(${base})`;
  }

  getCommandDisplayName(cmd: CustomCommand): string {
    const parts: string[] = [`/${cmd.name}`];

    if (cmd.config.argumentHint) {
      parts.push(cmd.config.argumentHint);
    }

    if (cmd.config.description) {
      parts.push('-', cmd.config.description);
    }

    parts.push(this.getCommandLabel(cmd));

    return parts.join(' ');
  }

  getCommandsBySource(): {
    project: CustomCommand[];
    user: CustomCommand[];
  } {
    const project: CustomCommand[] = [];
    const user: CustomCommand[] = [];

    for (const cmd of this.commands.values()) {
      if (cmd.source === 'project') {
        project.push(cmd);
      } else {
        user.push(cmd);
      }
    }

    return { project, user };
  }

  getLastDiscoveryResult(): CustomCommandDiscoveryResult | null {
    return this.lastDiscoveryResult;
  }

  getCommandDirs(): {
    projectBlade: string;
    projectClaude: string;
    userBlade: string;
    userClaude: string;
  } | null {
    if (!this.workspaceRoot) {
      return null;
    }
    return this.loader.getCommandDirs(this.workspaceRoot);
  }

  generateCommandListDescription(charBudget = 15000): {
    text: string;
    includedCount: number;
    totalCount: number;
  } {
    const commands = this.getModelInvocableCommands();
    const totalCount = commands.length;

    if (totalCount === 0) {
      return {
        text: 'No custom commands available.',
        includedCount: 0,
        totalCount: 0,
      };
    }

    let text = 'Available custom commands:\n\n';
    let charCount = text.length;
    let includedCount = 0;

    for (const cmd of commands) {
      const label = this.getCommandLabel(cmd);
      const argHint = cmd.config.argumentHint ? ` ${cmd.config.argumentHint}` : '';
      const line = `- /${cmd.name}${argHint}: ${cmd.config.description} ${label}\n`;

      if (charCount + line.length > charBudget) {
        break;
      }

      text += line;
      charCount += line.length;
      includedCount++;
    }

    if (includedCount < totalCount) {
      text += `\n(${includedCount} of ${totalCount} commands shown due to character budget)`;
    }

    return { text, includedCount, totalCount };
  }
}
