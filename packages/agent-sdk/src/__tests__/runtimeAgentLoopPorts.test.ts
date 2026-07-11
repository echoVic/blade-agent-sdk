import { describe, expect, it } from 'vitest';
import { createPackageLocalAgentLoopPorts } from '../session/runtimeAgentLoopPorts.js';
import { runPackageLocalTurn } from '../session/runtimeRunTurn.js';
import { executePackageLocalToolCalls } from '../session/runtimeToolExecution.js';

describe('package-local agent loop ports', () => {
  it('composes the session run-turn and batch tool execution ports', () => {
    const ports = createPackageLocalAgentLoopPorts();

    expect(ports.runTurn).toBe(runPackageLocalTurn);
    expect(ports.executeToolCalls).toBe(executePackageLocalToolCalls);
  });
});
