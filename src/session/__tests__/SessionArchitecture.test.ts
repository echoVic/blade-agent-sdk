import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SESSION_MODULES = [
  'Session.ts',
  'AgentSession.ts',
  'SessionLifecycle.ts',
  'SessionRequestCoordinator.ts',
  'SessionDurability.ts',
  'SessionState.ts',
  'SessionStreamRunner.ts',
  'StreamBroadcaster.ts',
] as const;

describe('Session module boundaries', () => {
  it.each(SESSION_MODULES)('keeps %s below 800 lines', (filename) => {
    const file = resolve('src/session', filename);

    expect(existsSync(file), `${filename} must exist`).toBe(true);
    const lineCount = readFileSync(file, 'utf8').split('\n').length;
    expect(lineCount, `${filename} has ${lineCount} lines`).toBeLessThan(800);
  });

  it('keeps Session.ts as the factory entrypoint instead of the implementation owner', () => {
    const source = readFileSync(resolve('src/session/Session.ts'), 'utf8');

    expect(source).toContain("from './AgentSession.js'");
    expect(source).not.toContain('class Session implements ISession');
  });

  it('owns the SessionRunner contract under advanced', () => {
    const advancedRunner = resolve('src/advanced/SessionRunner.ts');

    expect(existsSync(advancedRunner)).toBe(true);
    expect(readFileSync(advancedRunner, 'utf8')).toContain('export interface SessionRunner');
    expect(existsSync(resolve('src/server/SessionRunner.ts'))).toBe(false);
  });
});
