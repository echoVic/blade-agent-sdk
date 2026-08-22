import { describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { collectToolExecution } from '../../types/index.js';
import { SessionId } from '../../../types/branded.js';
import { globTool } from '../search/glob.js';
import { grepTool } from '../search/grep.js';
import { bashTool } from '../shell/bash.js';

const emptySnapshot = createContextSnapshot(SessionId('session-1'), 'turn-1', {});

describe('tool runtime context guards', () => {
  it('should reject Glob without filesystem capability', async () => {
    const invocation = globTool.build({
      pattern: '**/*.ts',
      max_results: 10,
      include_directories: false,
      case_sensitive: false,
    });

    const result = await collectToolExecution(
      invocation.execute(
        new AbortController().signal,
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Grep without filesystem capability', async () => {
    const invocation = grepTool.build({
      pattern: 'needle',
      output_mode: 'files_with_matches',
      '-i': false,
      '-n': true,
      multiline: false,
    });

    const result = await collectToolExecution(
      invocation.execute(
        new AbortController().signal,
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No filesystem access in current context');
  });

  it('should reject Bash without an explicit cwd or filesystem context cwd', async () => {
    const invocation = bashTool.build({
      command: 'pwd',
      timeout: 1000,
      run_in_background: false,
    });

    const result = await collectToolExecution(
      invocation.execute(
        new AbortController().signal,
        { contextSnapshot: emptySnapshot },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No working directory available');
  });
});
