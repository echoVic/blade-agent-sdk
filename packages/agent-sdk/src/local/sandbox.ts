import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NetworkSandboxSettings, SandboxSettings } from '../types/common.js';

interface LoggerLike {
  child?: (_category: unknown) => LoggerLike;
  debug?: (message: string) => void;
}

const noopLogger: LoggerLike = {
  child: () => noopLogger,
  debug: () => {},
};

export interface SandboxExecutionOptions {
  workDir: string;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  allowNetwork?: boolean;
  allowedNetworkHosts?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface SandboxCapabilities {
  available: boolean;
  type: 'bubblewrap' | 'seatbelt' | 'none';
  version?: string;
  features: {
    fileSystemIsolation: boolean;
    networkIsolation: boolean;
    processIsolation: boolean;
  };
}

export class SandboxExecutor {
  private static instance: SandboxExecutor | null = null;
  private logger: LoggerLike = noopLogger;
  private capabilities: SandboxCapabilities | null = null;
  private settings: SandboxSettings = {};

  private constructor() {}

  static getInstance(logger?: LoggerLike): SandboxExecutor {
    if (!SandboxExecutor.instance) {
      SandboxExecutor.instance = new SandboxExecutor();
    }
    if (logger) {
      SandboxExecutor.instance.setLogger(logger);
    }
    return SandboxExecutor.instance;
  }

  static resetInstance(): void {
    SandboxExecutor.instance = null;
  }

  setLogger(logger: LoggerLike): void {
    this.logger = logger.child?.('tool') ?? logger;
  }

  configure(settings: SandboxSettings): void {
    this.settings = { ...settings };
  }

  getCapabilities(): SandboxCapabilities {
    this.capabilities ??= this.detectCapabilities();
    return this.capabilities;
  }

  isEnabled(): boolean {
    return this.settings.enabled === true;
  }

  canUseSandbox(): boolean {
    return this.isEnabled() && this.getCapabilities().available;
  }

  wrapCommand(command: string, options: SandboxExecutionOptions): string {
    if (!this.canUseSandbox()) {
      return command;
    }

    const capabilities = this.getCapabilities();
    if (capabilities.type === 'bubblewrap') {
      return this.wrapWithBubblewrap(command, options);
    }
    if (capabilities.type === 'seatbelt') {
      return this.wrapWithSeatbelt(command, options);
    }
    return command;
  }

  buildExecutionOptions(
    workDir: string,
    networkSettings?: NetworkSandboxSettings,
  ): SandboxExecutionOptions {
    const options: SandboxExecutionOptions = {
      workDir,
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowNetwork: networkSettings?.allowLocalBinding !== false,
    };

    const homeDir = process.env.HOME;
    if (homeDir) {
      options.allowedReadPaths?.push(homeDir);
    }

    return options;
  }

  private detectCapabilities(): SandboxCapabilities {
    if (process.platform === 'linux') {
      return this.detectLinuxCapabilities();
    }
    if (process.platform === 'darwin') {
      return this.detectMacOSCapabilities();
    }
    return unavailableCapabilities();
  }

  private detectLinuxCapabilities(): SandboxCapabilities {
    try {
      const version = execSync('bwrap --version 2>/dev/null', { encoding: 'utf8' }).trim();
      this.logger.debug?.(`[SandboxExecutor] Detected bubblewrap: ${version}`);
      return availableCapabilities('bubblewrap', version);
    } catch {
      this.logger.debug?.('[SandboxExecutor] bubblewrap not available on Linux');
      return unavailableCapabilities();
    }
  }

  private detectMacOSCapabilities(): SandboxCapabilities {
    try {
      if (existsSync('/usr/bin/sandbox-exec')) {
        this.logger.debug?.('[SandboxExecutor] Detected macOS sandbox-exec (Seatbelt)');
        return availableCapabilities('seatbelt', 'macOS built-in');
      }
    } catch {
      this.logger.debug?.('[SandboxExecutor] sandbox-exec not available on macOS');
    }
    return unavailableCapabilities();
  }

  private wrapWithBubblewrap(command: string, options: SandboxExecutionOptions): string {
    const args: string[] = [
      '--ro-bind /usr /usr',
      '--ro-bind /bin /bin',
    ];

    for (const systemPath of [
      '/lib',
      '/lib64',
      '/etc/resolv.conf',
      '/etc/hosts',
      '/etc/ssl',
      '/etc/ca-certificates',
    ]) {
      if (existsSync(systemPath)) {
        args.push(`--ro-bind ${systemPath} ${systemPath}`);
      }
    }

    args.push('--proc /proc');
    args.push('--dev /dev');
    args.push('--tmpfs /tmp');
    args.push(`--bind ${options.workDir} ${options.workDir}`);
    args.push(`--chdir ${options.workDir}`);

    for (const writablePath of options.allowedWritePaths ?? []) {
      if (existsSync(writablePath) && writablePath !== options.workDir) {
        args.push(`--bind ${writablePath} ${writablePath}`);
      }
    }

    for (const readablePath of options.allowedReadPaths ?? []) {
      if (existsSync(readablePath)) {
        args.push(`--ro-bind ${readablePath} ${readablePath}`);
      }
    }

    const homeDir = process.env.HOME;
    if (homeDir) {
      for (const [relativePath, bindMode] of [
        ['.nvm', '--ro-bind'],
        ['.npm', '--bind'],
        ['.pnpm', '--bind'],
      ] as const) {
        const targetPath = join(homeDir, relativePath);
        if (existsSync(targetPath)) {
          args.push(`${bindMode} ${targetPath} ${targetPath}`);
        }
      }
    }

    if (!options.allowNetwork) {
      args.push('--unshare-net');
    }

    args.push('--unshare-user');
    args.push('--unshare-pid');
    args.push('--unshare-uts');
    args.push('--unshare-cgroup');
    args.push('--die-with-parent');
    args.push('--new-session');

    return `bwrap ${args.join(' ')} -- /bin/bash -c '${escapeShellSingleQuotes(command)}'`;
  }

  private wrapWithSeatbelt(command: string, options: SandboxExecutionOptions): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-'));
    const profilePath = join(tempDir, 'sandbox.sb');
    writeFileSync(profilePath, this.generateSeatbeltProfile(options), 'utf8');

    return [
      `sandbox-exec -f '${profilePath}' /bin/bash -c '${escapeShellSingleQuotes(command)}'`,
      'EXIT_CODE=$?',
      `rm -rf '${tempDir}'`,
      'exit $EXIT_CODE',
    ].join('; ');
  }

  private generateSeatbeltProfile(options: SandboxExecutionOptions): string {
    const lines: string[] = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow signal)',
      '(allow sysctl-read)',
      '(allow mach-lookup)',
      '(allow mach-register)',
      '(allow ipc-posix-shm)',
      '(allow file-read-metadata)',
    ];

    for (const readablePath of [
      '/usr',
      '/bin',
      '/sbin',
      '/Library',
      '/System',
      '/private/var/db',
      '/private/etc',
      '/dev',
      '/var',
      '/opt/homebrew',
      '/usr/local',
    ]) {
      lines.push(`(allow file-read* (subpath "${readablePath}"))`);
    }

    const homeDir = process.env.HOME;
    if (homeDir) {
      for (const relativePath of ['.nvm', '.npm', '.pnpm', '.config']) {
        lines.push(`(allow file-read* (subpath "${homeDir}/${relativePath}"))`);
      }
      for (const relativePath of ['.npm', '.pnpm']) {
        lines.push(`(allow file-write* (subpath "${homeDir}/${relativePath}"))`);
      }
    }

    lines.push(`(allow file-read* (subpath "${options.workDir}"))`);
    lines.push(`(allow file-write* (subpath "${options.workDir}"))`);

    for (const readablePath of options.allowedReadPaths ?? []) {
      lines.push(`(allow file-read* (subpath "${readablePath}"))`);
    }
    for (const writablePath of options.allowedWritePaths ?? []) {
      lines.push(`(allow file-write* (subpath "${writablePath}"))`);
    }

    for (const tempPath of ['/private/tmp', '/tmp']) {
      lines.push(`(allow file-read* (subpath "${tempPath}"))`);
      lines.push(`(allow file-write* (subpath "${tempPath}"))`);
    }

    lines.push(
      options.allowNetwork === false
        ? '(allow network-outbound (remote unix-socket))'
        : '(allow network*)',
    );

    return lines.join('\n');
  }
}

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

export function getSandboxExecutor(logger?: LoggerLike): SandboxExecutor {
  return SandboxExecutor.getInstance(logger);
}

export function getSandboxService(): SandboxService {
  return SandboxService.getInstance();
}

function availableCapabilities(
  type: Exclude<SandboxCapabilities['type'], 'none'>,
  version: string,
): SandboxCapabilities {
  return {
    available: true,
    type,
    version,
    features: {
      fileSystemIsolation: true,
      networkIsolation: true,
      processIsolation: true,
    },
  };
}

function unavailableCapabilities(): SandboxCapabilities {
  return {
    available: false,
    type: 'none',
    features: {
      fileSystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    },
  };
}

function escapeShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
