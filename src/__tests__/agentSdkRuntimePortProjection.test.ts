import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectionModulePath =
  '../../packages/agent-sdk/src/session/runtimePortProjection.js';
const projectionSourcePath = 'packages/agent-sdk/src/session/runtimePortProjection.ts';

describe('agent-sdk package-local runtime port projection helpers', () => {
  it('projects resolved ports and option factories without constructing a session runtime', async () => {
    expect(existsSync(projectionSourcePath)).toBe(true);

    const { projectPackageLocalRuntimePortFields } = await import(projectionModulePath);
    const ports = {
      sessionStore: { port: 'session-store' },
      workspace: { port: 'workspace' },
      mcpRegistry: { port: 'mcp-registry' },
      toolCatalog: { port: 'tool-catalog' },
      logger: { warn() {} },
      subagentRegistry: { port: 'subagents' },
      permissionHooks: { port: 'permission-hooks' },
      hookRuntime: { port: 'hook-runtime' },
      hookManager: { port: 'hook-manager' },
      backgroundAgentManager: { port: 'background-manager' },
      executionPipelineFactory: { port: 'execution-pipeline-factory' },
      kernelPortFactory: { port: 'kernel-port-factory' },
      kernelFactory: { port: 'kernel-factory' },
      kernelModelResolver: { port: 'kernel-model-resolver' },
    };
    const customToolFactory = { fromDefinition: () => ({ name: 'custom' }) };
    const builtinToolProvider = { getTools: async () => [] };

    const fields = projectPackageLocalRuntimePortFields({
      ports,
      options: {
        customToolFactory,
        builtinToolProvider,
      },
    });

    expect(fields.sessionStore).toBe(ports.sessionStore);
    expect(fields.hookManager).toBe(ports.hookManager);
    expect(fields.kernelModelResolver).toBe(ports.kernelModelResolver);
    expect(fields.customToolFactory).toBe(customToolFactory);
    expect(fields.builtinToolProvider).toBe(builtinToolProvider);
  });
});
