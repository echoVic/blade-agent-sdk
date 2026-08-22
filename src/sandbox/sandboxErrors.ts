import { ConfigError } from '../errors/ConfigError.js';

export function createSandboxUnavailableError(): ConfigError {
  return new ConfigError(
    `Sandbox is enabled, but no supported sandbox executor is available on ${process.platform}. ` +
      'Install Bubblewrap on Linux or disable sandbox explicitly.',
  );
}
