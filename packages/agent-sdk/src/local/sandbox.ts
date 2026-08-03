import type { NetworkSandboxSettings, SandboxSettings } from '../types/common.js';
import { getSandboxExecutor } from './SandboxExecutor.js';
import type { SandboxCapabilities } from './SandboxExecutor.js';

export interface SandboxExecutionContext {
  command: string;
  dangerouslyDisableSandbox?: boolean;
  workDir?: string;
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
  requiresPermission?: boolean;
  isExcluded?: boolean;
}

export class SandboxService {
  private static instance: SandboxService | null = null;
  private settings: SandboxSettings = {};

  private constructor() {}

  static getInstance(): SandboxService {
    SandboxService.instance ??= new SandboxService();
    return SandboxService.instance;
  }

  static resetInstance(): void {
    SandboxService.instance = null;
  }

  configure(settings: SandboxSettings): void {
    this.settings = { ...settings };
    getSandboxExecutor().configure(settings);
  }

  getSettings(): SandboxSettings {
    return { ...this.settings };
  }

  isEnabled(): boolean {
    return this.settings.enabled === true;
  }

  shouldAutoAllowBash(): boolean {
    return this.isEnabled() && this.settings.autoAllowBashIfSandboxed === true;
  }

  isCommandExcluded(command: string): boolean {
    const excludedCommands = this.settings.excludedCommands ?? [];
    if (excludedCommands.length === 0) {
      return false;
    }

    const commandName = this.extractCommandName(command);
    return excludedCommands.some(
      (excluded) => commandName === excluded || command.startsWith(`${excluded} `),
    );
  }

  allowsUnsandboxedCommands(): boolean {
    return this.settings.allowUnsandboxedCommands === true;
  }

  checkCommand(ctx: SandboxExecutionContext): SandboxCheckResult {
    const { command, dangerouslyDisableSandbox } = ctx;

    if (!this.isEnabled()) {
      return { allowed: true, reason: 'Sandbox is disabled' };
    }

    if (this.isCommandExcluded(command)) {
      return { allowed: true, reason: 'Command is in excluded list', isExcluded: true };
    }

    if (dangerouslyDisableSandbox) {
      if (this.allowsUnsandboxedCommands()) {
        return {
          allowed: false,
          reason: 'Command requests unsandboxed execution',
          requiresPermission: true,
        };
      }
      return {
        allowed: false,
        reason: 'Unsandboxed commands are not allowed',
      };
    }

    return { allowed: true, reason: 'Command will run in sandbox' };
  }

  shouldIgnoreFileViolation(filePath: string): boolean {
    return this.matchesAnyPattern(filePath, this.settings.ignoreViolations?.file ?? [], 'prefix');
  }

  shouldIgnoreNetworkViolation(target: string): boolean {
    return this.matchesAnyPattern(target, this.settings.ignoreViolations?.network ?? [], 'exact');
  }

  getNetworkSettings(): NetworkSandboxSettings {
    return this.settings.network ?? {};
  }

  allowsLocalBinding(): boolean {
    return this.settings.network?.allowLocalBinding === true;
  }

  isUnixSocketAllowed(socketPath: string): boolean {
    const network = this.settings.network;
    if (!network) {
      return false;
    }
    if (network.allowAllUnixSockets) {
      return true;
    }
    return network.allowUnixSockets?.includes(socketPath) ?? false;
  }

  wrapCommandForSandbox(command: string, workDir: string): string {
    if (!this.isEnabled()) {
      return command;
    }

    const executor = getSandboxExecutor();
    if (!executor.canUseSandbox()) {
      return command;
    }

    return executor.wrapCommand(command, executor.buildExecutionOptions(workDir, this.settings.network));
  }

  getCapabilities(): SandboxCapabilities {
    return getSandboxExecutor().getCapabilities();
  }

  private extractCommandName(command: string): string {
    return command.trim().split(/\s+/)[0] || '';
  }

  private matchesAnyPattern(
    value: string,
    patterns: string[],
    defaultMode: 'exact' | 'prefix',
  ): boolean {
    return patterns.some((pattern) => {
      if (pattern.includes('*')) {
        return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`).test(value);
      }
      return defaultMode === 'exact'
        ? value === pattern || value.startsWith(pattern)
        : value.startsWith(pattern);
    });
  }
}

export function getSandboxService(): SandboxService {
  return SandboxService.getInstance();
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}
