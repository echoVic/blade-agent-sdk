import type { AgentStreamEvent } from '@blade-ai/agent';

export interface PackageLocalKernelTraceFinalizationState {
  usage?: unknown;
}

export interface PackageLocalKernelTraceFinalizerPort {
  finish(status: 'success' | 'error', data?: Record<string, unknown>): Promise<unknown>;
}

export interface PackageLocalKernelTraceFinalizationOptions {
  state: PackageLocalKernelTraceFinalizationState;
  traceFinalizer: PackageLocalKernelTraceFinalizerPort;
}

export async function updatePackageLocalKernelTraceFinalization(
  event: AgentStreamEvent,
  options: PackageLocalKernelTraceFinalizationOptions,
): Promise<void> {
  if (event.type === 'usage') {
    options.state.usage = event.usage;
    return;
  }

  if (event.type === 'result') {
    await options.traceFinalizer.finish('success', {
      content: event.content,
      usage: options.state.usage,
    });
    return;
  }

  if (event.type === 'error') {
    await options.traceFinalizer.finish('error', {
      error: event.message,
      code: event.code,
    });
  }
}

export async function finishPackageLocalKernelTraceError(
  error: unknown,
  traceFinalizer: PackageLocalKernelTraceFinalizerPort,
): Promise<void> {
  await traceFinalizer.finish('error', {
    error: error instanceof Error ? error.message : String(error),
  });
}
