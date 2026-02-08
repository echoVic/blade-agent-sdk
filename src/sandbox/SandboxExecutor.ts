import { execSync, spawn, type SpawnOptions } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SandboxSettings, NetworkSandboxSettings } from '../types/common.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.TOOL);

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
  private capabilities: SandboxCapabilities | null = null;
  private settings: SandboxSettings = {};

  private constructor() {}

  static getInstance(): SandboxExecutor {
    if (!SandboxExecutor.instance) {
      SandboxExecutor.instance = new SandboxExecutor();
    }
    return SandboxExecutor.instance;
  }

  static resetInstance(): void {
    SandboxExecutor.instance = null;
  }

  configure(settings: SandboxSettings): void {
    this.settings = { ...settings };
  }

  getCapabilities(): SandboxCapabilities {
    if (this.capabilities) {
      return this.capabilities;
    }

    this.capabilities = this.detectCapabilities();
    return this.capabilities;
  }

  private detectCapabilities(): SandboxCapabilities {
    const platform = process.platform;

    if (platform === 'linux') {
      return this.detectLinuxCapabilities();
    } else if (platform === 'darwin') {
      return this.detectMacOSCapabilities();
    }

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

  private detectLinuxCapabilities(): SandboxCapabilities {
    try {
      const version = execSync('bwrap --version 2>/dev/null', { encoding: 'utf-8' }).trim();
      logger.debug(`[SandboxExecutor] Detected bubblewrap: ${version}`);

      return {
        available: true,
        type: 'bubblewrap',
        version,
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      };
    } catch {
      logger.debug('[SandboxExecutor] bubblewrap not available on Linux');
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
  }

  private detectMacOSCapabilities(): SandboxCapabilities {
    try {
      const sandboxExecPath = '/usr/bin/sandbox-exec';
      if (existsSync(sandboxExecPath)) {
        logger.debug('[SandboxExecutor] Detected macOS sandbox-exec (Seatbelt)');

        return {
          available: true,
          type: 'seatbelt',
          version: 'macOS built-in',
          features: {
            fileSystemIsolation: true,
            networkIsolation: true,
            processIsolation: true,
          },
        };
      }
    } catch {
      logger.debug('[SandboxExecutor] sandbox-exec not available on macOS');
    }

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
    } else if (capabilities.type === 'seatbelt') {
      return this.wrapWithSeatbelt(command, options);
    }

    return command;
  }

  private wrapWithBubblewrap(command: string, options: SandboxExecutionOptions): string {
    const args: string[] = [];

    args.push('--ro-bind /usr /usr');
    args.push('--ro-bind /bin /bin');

    if (existsSync('/lib')) {
      args.push('--ro-bind /lib /lib');
    }
    if (existsSync('/lib64')) {
      args.push('--ro-bind /lib64 /lib64');
    }
    if (existsSync('/etc/resolv.conf')) {
      args.push('--ro-bind /etc/resolv.conf /etc/resolv.conf');
    }
    if (existsSync('/etc/hosts')) {
      args.push('--ro-bind /etc/hosts /etc/hosts');
    }
    if (existsSync('/etc/ssl')) {
      args.push('--ro-bind /etc/ssl /etc/ssl');
    }
    if (existsSync('/etc/ca-certificates')) {
      args.push('--ro-bind /etc/ca-certificates /etc/ca-certificates');
    }

    args.push('--proc /proc');
    args.push('--dev /dev');
    args.push('--tmpfs /tmp');

    args.push(`--bind ${options.workDir} ${options.workDir}`);
    args.push(`--chdir ${options.workDir}`);

    if (options.allowedWritePaths) {
      for (const path of options.allowedWritePaths) {
        if (existsSync(path) && path !== options.workDir) {
          args.push(`--bind ${path} ${path}`);
        }
      }
    }

    if (options.allowedReadPaths) {
      for (const path of options.allowedReadPaths) {
        if (existsSync(path)) {
          args.push(`--ro-bind ${path} ${path}`);
        }
      }
    }

    const homeDir = process.env.HOME;
    if (homeDir) {
      const nodePath = join(homeDir, '.nvm');
      if (existsSync(nodePath)) {
        args.push(`--ro-bind ${nodePath} ${nodePath}`);
      }
      const npmPath = join(homeDir, '.npm');
      if (existsSync(npmPath)) {
        args.push(`--bind ${npmPath} ${npmPath}`);
      }
      const pnpmPath = join(homeDir, '.pnpm');
      if (existsSync(pnpmPath)) {
        args.push(`--bind ${pnpmPath} ${pnpmPath}`);
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

    const escapedCommand = command.replace(/'/g, "'\\''");
    return `bwrap ${args.join(' ')} -- /bin/bash -c '${escapedCommand}'`;
  }

  private wrapWithSeatbelt(command: string, options: SandboxExecutionOptions): string {
    const profile = this.generateSeatbeltProfile(options);

    const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-'));
    const profilePath = join(tempDir, 'sandbox.sb');
    writeFileSync(profilePath, profile, 'utf-8');

    const escapedCommand = command.replace(/'/g, "'\\''");

    const cleanupAndRun = `sandbox-exec -f '${profilePath}' /bin/bash -c '${escapedCommand}'; EXIT_CODE=$?; rm -rf '${tempDir}'; exit $EXIT_CODE`;

    return cleanupAndRun;
  }

  private generateSeatbeltProfile(options: SandboxExecutionOptions): string {
    const lines: string[] = [];

    lines.push('(version 1)');

    lines.push('(deny default)');

    lines.push('(allow process-exec)');
    lines.push('(allow process-fork)');
    lines.push('(allow signal)');

    lines.push('(allow sysctl-read)');
    lines.push('(allow mach-lookup)');
    lines.push('(allow mach-register)');
    lines.push('(allow ipc-posix-shm)');

    lines.push('(allow file-read-metadata)');

    lines.push('(allow file-read* (subpath "/usr"))');
    lines.push('(allow file-read* (subpath "/bin"))');
    lines.push('(allow file-read* (subpath "/sbin"))');
    lines.push('(allow file-read* (subpath "/Library"))');
    lines.push('(allow file-read* (subpath "/System"))');
    lines.push('(allow file-read* (subpath "/private/var/db"))');
    lines.push('(allow file-read* (subpath "/private/etc"))');
    lines.push('(allow file-read* (subpath "/dev"))');
    lines.push('(allow file-read* (subpath "/var"))');

    lines.push('(allow file-read* (subpath "/opt/homebrew"))');
    lines.push('(allow file-read* (subpath "/usr/local"))');

    const homeDir = process.env.HOME;
    if (homeDir) {
      lines.push(`(allow file-read* (subpath "${homeDir}/.nvm"))`);
      lines.push(`(allow file-read* (subpath "${homeDir}/.npm"))`);
      lines.push(`(allow file-read* (subpath "${homeDir}/.pnpm"))`);
      lines.push(`(allow file-read* (subpath "${homeDir}/.config"))`);
      lines.push(`(allow file-write* (subpath "${homeDir}/.npm"))`);
      lines.push(`(allow file-write* (subpath "${homeDir}/.pnpm"))`);
    }

    lines.push(`(allow file-read* (subpath "${options.workDir}"))`);
    lines.push(`(allow file-write* (subpath "${options.workDir}"))`);

    if (options.allowedReadPaths) {
      for (const path of options.allowedReadPaths) {
        lines.push(`(allow file-read* (subpath "${path}"))`);
      }
    }

    if (options.allowedWritePaths) {
      for (const path of options.allowedWritePaths) {
        lines.push(`(allow file-write* (subpath "${path}"))`);
      }
    }

    lines.push('(allow file-read* (subpath "/private/tmp"))');
    lines.push('(allow file-write* (subpath "/private/tmp"))');
    lines.push('(allow file-read* (subpath "/tmp"))');
    lines.push('(allow file-write* (subpath "/tmp"))');

    if (options.allowNetwork !== false) {
      lines.push('(allow network*)');
    } else {
      lines.push('(allow network-outbound (remote unix-socket))');
    }

    return lines.join('\n');
  }

  buildExecutionOptions(workDir: string, networkSettings?: NetworkSandboxSettings): SandboxExecutionOptions {
    const options: SandboxExecutionOptions = {
      workDir,
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowNetwork: true,
    };

    if (networkSettings) {
      if (networkSettings.allowLocalBinding === false) {
        options.allowNetwork = false;
      }
    }

    const homeDir = process.env.HOME;
    if (homeDir) {
      options.allowedReadPaths?.push(homeDir);
    }

    return options;
  }
}

export function getSandboxExecutor(): SandboxExecutor {
  return SandboxExecutor.getInstance();
}
