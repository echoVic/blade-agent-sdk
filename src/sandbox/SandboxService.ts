import type { SandboxSettings } from '../types/common.js';
import { getSandboxExecutor } from './SandboxExecutor.js';

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
    if (!SandboxService.instance) {
      SandboxService.instance = new SandboxService();
    }
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
    if (!this.settings.excludedCommands || this.settings.excludedCommands.length === 0) {
      return false;
    }

    const commandName = this.extractCommandName(command);
    return this.settings.excludedCommands.some(
      (excluded) => commandName === excluded || command.startsWith(excluded + ' ')
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
      } else {
        return {
          allowed: false,
          reason: 'Unsandboxed commands are not allowed',
        };
      }
    }

    return { allowed: true, reason: 'Command will run in sandbox' };
  }

  shouldIgnoreFileViolation(filePath: string): boolean {
    if (!this.settings.ignoreViolations?.file) {
      return false;
    }

    return this.settings.ignoreViolations.file.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(filePath);
      }
      return filePath.startsWith(pattern);
    });
  }

  shouldIgnoreNetworkViolation(target: string): boolean {
    if (!this.settings.ignoreViolations?.network) {
      return false;
    }

    return this.settings.ignoreViolations.network.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(target);
      }
      return target === pattern || target.startsWith(pattern);
    });
  }

  getNetworkSettings() {
    return this.settings.network || {};
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

    if (network.allowUnixSockets && network.allowUnixSockets.length > 0) {
      return network.allowUnixSockets.includes(socketPath);
    }

    return false;
  }

  private extractCommandName(command: string): string {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    return parts[0] || '';
  }

  wrapCommandForSandbox(command: string, workDir?: string): string {
    if (!this.isEnabled()) {
      return command;
    }

    const executor = getSandboxExecutor();
    if (!executor.canUseSandbox()) {
      return command;
    }

    const effectiveWorkDir = workDir || process.cwd();
    const options = executor.buildExecutionOptions(effectiveWorkDir, this.settings.network);
    return executor.wrapCommand(command, options);
  }

  getCapabilities() {
    return getSandboxExecutor().getCapabilities();
  }
}

export function getSandboxService(): SandboxService {
  return SandboxService.getInstance();
}
