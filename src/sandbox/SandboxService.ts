import type { SandboxSettings } from './config.js';
import { getSandboxExecutor } from './SandboxExecutor.js';
import { createSandboxUnavailableError } from './sandboxErrors.js';

export interface SandboxExecutionContext {
  command: string;
  dangerouslyDisableSandbox?: boolean;
  workDir?: string;
}

export type SandboxCheckOutcome =
  | 'disabled'
  | 'excluded'
  | 'unavailable'
  | 'sandboxed'
  | 'requires_permission'
  | 'denied';

export interface SandboxCheckResult {
  outcome: SandboxCheckOutcome;
  reason: string;
}

/**
 * Sandbox policy decisions. The service holds no policy of its own: settings are
 * passed per call, because one process serves many Sessions and a stored policy
 * would leak one Session's configuration into another's executions.
 *
 * Only platform capability detection is process-wide, which is the one fact that
 * is genuinely shared.
 */
export class SandboxService {
  private static instance: SandboxService | null = null;

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

  /**
   * Fail closed when an enabled policy has no usable platform sandbox, at the
   * point the policy is validated rather than at the point of execution.
   */
  assertUsable(settings: SandboxSettings): void {
    if (settings.enabled === true && !getSandboxExecutor().getCapabilities().available) {
      throw createSandboxUnavailableError();
    }
  }

  getSettings(settings: SandboxSettings): SandboxSettings {
    // Deep enough that a caller mutating the copy cannot reach the original arrays.
    return {
      ...settings,
      ...(settings.excludedCommands ? { excludedCommands: [...settings.excludedCommands] } : {}),
      ...(settings.ignoreViolations
        ? {
            ignoreViolations: {
              ...(settings.ignoreViolations.file
                ? { file: [...settings.ignoreViolations.file] }
                : {}),
              ...(settings.ignoreViolations.network
                ? { network: [...settings.ignoreViolations.network] }
                : {}),
            },
          }
        : {}),
      ...(settings.network
        ? {
            network: {
              ...settings.network,
              ...(settings.network.allowUnixSockets
                ? { allowUnixSockets: [...settings.network.allowUnixSockets] }
                : {}),
            },
          }
        : {}),
    };
  }

  isEnabled(settings: SandboxSettings): boolean {
    return settings.enabled === true;
  }

  shouldAutoAllowBash(settings: SandboxSettings): boolean {
    return (
      this.isEnabled(settings) &&
      settings.autoAllowBashIfSandboxed === true &&
      getSandboxExecutor().canUseSandbox(settings)
    );
  }

  isCommandExcluded(command: string, settings: SandboxSettings): boolean {
    if (!settings.excludedCommands || settings.excludedCommands.length === 0) {
      return false;
    }

    const commandName = this.extractCommandName(command);
    return settings.excludedCommands.some(
      (excluded) => commandName === excluded || command.startsWith(`${excluded} `),
    );
  }

  allowsUnsandboxedCommands(settings: SandboxSettings): boolean {
    return settings.allowUnsandboxedCommands === true;
  }

  checkCommand(ctx: SandboxExecutionContext, settings: SandboxSettings): SandboxCheckResult {
    const { command, dangerouslyDisableSandbox } = ctx;

    if (!this.isEnabled(settings)) {
      return { outcome: 'disabled', reason: 'Sandbox is disabled' };
    }

    if (this.isCommandExcluded(command, settings)) {
      return { outcome: 'excluded', reason: 'Command is in excluded list' };
    }

    if (dangerouslyDisableSandbox) {
      if (this.allowsUnsandboxedCommands(settings)) {
        return {
          outcome: 'requires_permission',
          reason: 'Command requests unsandboxed execution',
        };
      }
      return {
        outcome: 'denied',
        reason: 'Unsandboxed commands are not allowed',
      };
    }

    if (!getSandboxExecutor().canUseSandbox(settings)) {
      return {
        outcome: 'unavailable',
        reason: createSandboxUnavailableError().message,
      };
    }

    return { outcome: 'sandboxed', reason: 'Command will run in sandbox' };
  }

  shouldIgnoreFileViolation(filePath: string, settings: SandboxSettings): boolean {
    if (!settings.ignoreViolations?.file) {
      return false;
    }

    return settings.ignoreViolations.file.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return regex.test(filePath);
      }
      return filePath.startsWith(pattern);
    });
  }

  shouldIgnoreNetworkViolation(target: string, settings: SandboxSettings): boolean {
    if (!settings.ignoreViolations?.network) {
      return false;
    }

    return settings.ignoreViolations.network.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return regex.test(target);
      }
      return target === pattern || target.startsWith(pattern);
    });
  }

  getNetworkSettings(settings: SandboxSettings) {
    return settings.network || {};
  }

  allowsLocalBinding(settings: SandboxSettings): boolean {
    return settings.network?.allowLocalBinding === true;
  }

  isUnixSocketAllowed(socketPath: string, settings: SandboxSettings): boolean {
    const network = settings.network;
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

  /**
   * The executor decides whether the command is wrapped, so an excluded or
   * disabled policy is expressed as `enabled: false` rather than as a shortcut
   * here. The result is the same command, and one code path owns the decision.
   */
  wrapCommandForSandbox(command: string, workDir: string, settings: SandboxSettings): string {
    const executor = getSandboxExecutor();
    const effective = this.isCommandExcluded(command, settings)
      ? { ...settings, enabled: false }
      : settings;
    const options = executor.buildExecutionOptions(workDir, effective.network);
    return executor.wrapCommand(command, options, effective);
  }

  getCapabilities() {
    return getSandboxExecutor().getCapabilities();
  }
}

export function getSandboxService(): SandboxService {
  return SandboxService.getInstance();
}
