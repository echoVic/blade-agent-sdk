import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionMode, type BladeConfig } from '../../../../types/common.js';
import type { ExecutionContext } from '../../../types/ExecutionTypes.js';
import { exitPlanModeTool } from '../ExitPlanModeTool.js';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function executeWithContext(
  context: Partial<ExecutionContext>,
  plan = '# Plan\n\n1. Add tests'
) {
  const invocation = exitPlanModeTool.build({ plan });
  return invocation.execute(new AbortController().signal, undefined, context);
}

describe('ExitPlanMode Tool', () => {
  it('writes the plan file to bladeConfig.plansDirectory before requesting approval', async () => {
    const plansDirectory = await createTempDir('blade-plans-');
    const requestConfirmation = vi.fn(async () => ({
      approved: true,
      targetMode: PermissionMode.DEFAULT,
    }));

    const result = await executeWithContext({
      sessionId: 'session-123',
      bladeConfig: { plansDirectory } as BladeConfig,
      confirmationHandler: { requestConfirmation },
    });

    const planPath = join(plansDirectory, 'plan_session-123.md');
    expect(await readFile(planPath, 'utf8')).toBe('# Plan\n\n1. Add tests');
    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exitPlanMode',
        planContent: '# Plan\n\n1. Add tests',
      })
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.targetMode).toBe(PermissionMode.DEFAULT);
  });

  it('does not fall back to writing under $HOME/.blade/plans when plansDirectory is missing', async () => {
    const fakeHome = await createTempDir('blade-home-');
    process.env.HOME = fakeHome;

    const result = await executeWithContext({
      sessionId: 'session-456',
    });

    const defaultPlanPath = join(fakeHome, '.blade', 'plans', 'plan_session-456.md');
    expect(await pathExists(defaultPlanPath)).toBe(false);
    expect(result.success).toBe(true);
    expect(result.displayContent).toBe('Plan mode exit (non-interactive)');
  });
});
