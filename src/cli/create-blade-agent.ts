#!/usr/bin/env node

import {
  createBladeAgent,
  type CreateBladeAgentOptions,
  type CreateBladeAgentPackageManager,
  type CreateBladeAgentPreset,
  getBladeAgentSdkVersion,
} from './createBladeAgent.js';

const HELP = `create-blade-agent [directory] [options]

Create a runnable local, Web, or production Agent project.

Options:
  --preset <local|web|production>        Starter topology (default: production)
  --package-manager <npm|pnpm|yarn|bun>  Package manager used for installation
  --sdk-version <version-or-specifier>   SDK dependency (defaults to this CLI version)
  --skip-install                        Generate files without installing dependencies
  --verify                              Run the full smoke test after installation
  --help                                Show this help
  --version                             Show the installed SDK version
`;

interface ParsedArguments {
  readonly help: boolean;
  readonly version: boolean;
  readonly options: CreateBladeAgentOptions;
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePackageManager(value: string): CreateBladeAgentPackageManager {
  if (value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun') {
    return value;
  }
  throw new Error(`Unsupported package manager: ${value}`);
}

function parsePreset(value: string): CreateBladeAgentPreset {
  if (value === 'local' || value === 'web' || value === 'production') {
    return value;
  }
  throw new Error(`Unsupported starter preset: ${value}`);
}

export function parseCreateBladeAgentArgs(args: readonly string[]): ParsedArguments {
  let directory: string | undefined;
  let packageManager: CreateBladeAgentPackageManager | undefined;
  let preset: CreateBladeAgentPreset | undefined;
  let sdkSpecifier: string | undefined;
  let skipInstall = false;
  let verify = false;
  let help = false;
  let version = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--version' || argument === '-v') {
      version = true;
      continue;
    }
    if (argument === '--skip-install') {
      skipInstall = true;
      continue;
    }
    if (argument === '--verify') {
      verify = true;
      continue;
    }
    if (argument === '--package-manager') {
      packageManager = parsePackageManager(requiredValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--preset') {
      preset = parsePreset(requiredValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--sdk-version') {
      sdkSpecifier = requiredValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--package-manager=')) {
      packageManager = parsePackageManager(argument.slice('--package-manager='.length));
      continue;
    }
    if (argument?.startsWith('--preset=')) {
      preset = parsePreset(argument.slice('--preset='.length));
      continue;
    }
    if (argument?.startsWith('--sdk-version=')) {
      sdkSpecifier = argument.slice('--sdk-version='.length);
      continue;
    }
    if (argument?.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (directory !== undefined) {
      throw new Error('Only one target directory may be provided');
    }
    directory = argument;
  }

  return {
    help,
    version,
    options: {
      ...(directory ? { directory } : {}),
      ...(packageManager ? { packageManager } : {}),
      ...(preset ? { preset } : {}),
      ...(sdkSpecifier ? { sdkSpecifier } : {}),
      skipInstall,
      verify,
    },
  };
}

export async function runCreateBladeAgentCli(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseCreateBladeAgentArgs(args);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${await getBladeAgentSdkVersion()}\n`);
    return;
  }

  const result = await createBladeAgent(parsed.options);
  const run = result.packageManager === 'yarn' ? 'yarn' : `${result.packageManager} run`;
  const next = result.installed
    ? [`  ${run} start`]
    : [`  ${result.packageManager} install`, `  ${run} start`];
  process.stdout.write(
    [
      `Created ${result.directory}`,
      result.verified
        ? `Verified ${result.preset} first result in ${(result.elapsedMs / 1000).toFixed(2)}s`
        : [`Next in ${result.directory}:`, ...next].join('\n'),
      '',
    ].join('\n'),
  );
}

void runCreateBladeAgentCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
