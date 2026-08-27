const SAFE_PROCESS_ENV_KEYS = new Set([
  'COLORTERM',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
]);

/**
 * Builds the environment exposed to shell tools.
 *
 * Host process variables are denied by default except for a small set required
 * for normal command execution. Runtime and invocation environments are
 * explicit capability inputs and override the inherited baseline.
 */
export function buildShellEnvironment(
  runtimeEnvironment?: Readonly<Record<string, string>>,
  invocationEnvironment?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (SAFE_PROCESS_ENV_KEYS.has(key) || key.startsWith('LC_'))
    ) {
      environment[key] = value;
    }
  }

  for (const source of [runtimeEnvironment, invocationEnvironment]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined) {
        delete environment[key];
      } else {
        environment[key] = value;
      }
    }
  }

  environment.BLADE_CLI = '1';
  return environment;
}
