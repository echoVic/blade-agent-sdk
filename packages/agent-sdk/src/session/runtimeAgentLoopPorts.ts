import { runPackageLocalTurn } from './runtimeRunTurn.js';
import { executePackageLocalToolCalls } from './runtimeToolExecution.js';

export interface PackageLocalAgentLoopPorts {
  runTurn: typeof runPackageLocalTurn;
  executeToolCalls: typeof executePackageLocalToolCalls;
}

export function createPackageLocalAgentLoopPorts(): PackageLocalAgentLoopPorts {
  return {
    runTurn: runPackageLocalTurn,
    executeToolCalls: executePackageLocalToolCalls,
  };
}
