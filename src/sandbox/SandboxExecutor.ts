import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { NetworkSandboxSettings, SandboxSettings } from './config.js';
import { createSandboxUnavailableError } from './sandboxErrors.js';

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
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.TOOL);
  private capabilities: SandboxCapabilities | null = null;

  private constructor() {}

  static getInstance(logger?: InternalLogger): SandboxExecutor {
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

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.TOOL);
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
      this.logger.debug(`[SandboxExecutor] Detected bubblewrap: ${version}`);

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
      this.logger.debug('[SandboxExecutor] bubblewrap not available on Linux');
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
        this.logger.debug('[SandboxExecutor] Detected macOS sandbox-exec (Seatbelt)');

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
      this.logger.debug('[SandboxExecutor] sandbox-exec not available on macOS');
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

  isEnabled(settings: SandboxSettings): boolean {
    return settings.enabled === true;
  }

  canUseSandbox(settings: SandboxSettings): boolean {
    return this.isEnabled(settings) && this.getCapabilities().available;
  }

  /**
   * Sandbox policy is a parameter, never executor state: one process serves many
   * Sessions, and a policy stored here would be shared between them.
   */
  wrapCommand(
    command: string,
    options: SandboxExecutionOptions,
    settings: SandboxSettings,
  ): string {
    if (!this.isEnabled(settings)) {
      return command;
    }

    const capabilities = this.getCapabilities();
    if (!capabilities.available) {
      throw createSandboxUnavailableError();
    }

    if (capabilities.type === 'bubblewrap') {
      return this.wrapWithBubblewrap(command, options);
    } else if (capabilities.type === 'seatbelt') {
      return this.wrapWithSeatbelt(command, options);
    }

    throw createSandboxUnavailableError();
  }

  /**
   * A workspace path may cross a symlink (macOS's mkdtemp(tmpdir()) always does:
   * /var/folders/... resolves to /private/var/folders/...). The sandboxed process's
   * kernel-reported cwd is the resolved path, so a policy naming only the given
   * path denies it. Resolution fails open: callers legitimately pass paths that do
   * not exist yet, and existing tests rely on that not throwing.
   */
  private resolveRealPath(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  /**
   * A resolved path of "/" or a single top-level directory (e.g. "/var") is
   * too broad to grant additively: `realpathSync` performs no containment
   * check, so a workDir that is itself a symlink to (or through) a top-level
   * directory would otherwise turn the additive rule into a grant of that
   * entire root. Refusing it here only ever narrows what the additive rule
   * would have covered — the literal workDir rule stays in place, so a
   * workspace that genuinely resolves to a root is still covered by its own
   * given path, just not widened past it.
   */
  private isRootLikePath(path: string): boolean {
    return path.split('/').filter(Boolean).length <= 1;
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

    // Only the work directory is resolved to its real path, never the allowed
    // read/write lists below — see the comment above those loops for why.
    const realWorkDir = this.resolveRealPath(options.workDir);
    args.push(`--bind ${options.workDir} ${options.workDir}`);
    args.push(`--chdir ${options.workDir}`);
    if (realWorkDir !== options.workDir) {
      if (this.isRootLikePath(realWorkDir)) {
        this.logger.warn(
          `[SandboxExecutor] workDir "${options.workDir}" resolves to "${realWorkDir}", which is ` +
            'too broad to grant additively; only the given path is covered.',
        );
      } else {
        args.push(`--bind ${realWorkDir} ${realWorkDir}`);
      }
    }

    // Allowed paths are matched by their literal value only, never resolved.
    // A caller-supplied entry that crosses a symlink is dead policy here,
    // exactly as it was before the workDir fix above existed: resolving these
    // lists too would let one symlinked leaf (e.g. an allowed path planted to
    // point at "/") turn a single caller-supplied entry into a bind of its
    // resolved target's entire tree — a real widening, not a restatement of
    // what the caller already granted. See generateSeatbeltProfile for the
    // sandbox-exec experiment that established this. The read and write loops
    // are kept symmetric: both skip an entry that literally names the work
    // directory, so neither can emit a bind that shadows the read-write
    // workspace bind above under last-mount-wins.
    if (options.allowedWritePaths) {
      for (const path of options.allowedWritePaths) {
        if (existsSync(path) && path !== options.workDir && path !== realWorkDir) {
          args.push(`--bind ${path} ${path}`);
        }
      }
    }

    if (options.allowedReadPaths) {
      for (const path of options.allowedReadPaths) {
        if (existsSync(path) && path !== options.workDir && path !== realWorkDir) {
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

    // Newer macOS releases abort the sandboxed process unless "/" itself is readable.
    lines.push('(allow file-read* (literal "/"))');

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

    // Only the work directory is resolved to its real path. Experimentation
    // with sandbox-exec confirmed seatbelt matches a rule's target against the
    // accessed path's *canonical* form, while the rule text itself is never
    // canonicalized: naming an unresolved symlink grants nothing for what it
    // points at, and naming a resolved path grants that path's entire
    // subtree — including everything below it that the caller never named.
    // Resolving allowedReadPaths/allowedWritePaths as well would therefore let
    // one symlinked leaf (e.g. a planted "$HOME/.npm -> /") turn a single
    // caller-supplied entry into a grant of "/". Leaving those lists
    // unresolved keeps a symlink-crossing entry there dead policy, exactly as
    // it was before this file resolved anything — the safe direction, since
    // refusing to grant more than the caller literally named never takes away
    // access that existed before.
    const realWorkDir = this.resolveRealPath(options.workDir);
    lines.push(`(allow file-read* (subpath "${options.workDir}"))`);
    lines.push(`(allow file-write* (subpath "${options.workDir}"))`);
    if (realWorkDir !== options.workDir) {
      if (this.isRootLikePath(realWorkDir)) {
        this.logger.warn(
          `[SandboxExecutor] workDir "${options.workDir}" resolves to "${realWorkDir}", which is ` +
            'too broad to grant additively; only the given path is covered.',
        );
      } else {
        lines.push(`(allow file-read* (subpath "${realWorkDir}"))`);
        lines.push(`(allow file-write* (subpath "${realWorkDir}"))`);
      }
    }

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

  buildExecutionOptions(
    workDir: string,
    networkSettings?: NetworkSandboxSettings,
  ): SandboxExecutionOptions {
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

export function getSandboxExecutor(logger?: InternalLogger): SandboxExecutor {
  return SandboxExecutor.getInstance(logger);
}
