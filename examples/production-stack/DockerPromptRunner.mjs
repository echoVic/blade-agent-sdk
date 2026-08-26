import { requireQueuedRequest } from './QueuedSessionExecutor.mjs';

function withoutQueuedRequest(metadata) {
  const { bladeQueuedRequest: _queuedRequest, ...rest } = metadata;
  return rest;
}

export class DockerPromptRunner {
  constructor(options) {
    this.image = options.image;
    this.publish = options.publish;
  }

  async run(context) {
    const host = context.executionHost;
    if (!host) {
      throw new TypeError('DockerPromptRunner requires an ExecutionHost');
    }
    const queued = requireQueuedRequest(context.claim.route.metadata);
    const metadata = withoutQueuedRequest(context.claim.route.metadata);
    await context.transition('running', context.claim.route.metadata);
    const execution = await host.provision({
      image: this.image,
      workspace: { kind: 'empty' },
      resources: {
        cpus: 0.25,
        memoryBytes: 32 * 1024 * 1024,
        diskBytes: 8 * 1024 * 1024,
        pids: 32,
        runtimeMs: 30_000,
        maxOutputBytes: 16 * 1024,
      },
      network: { mode: 'none' },
      signal: context.signal,
    });

    try {
      await this.publish(
        context.claim.route.tenantId,
        context.claim.route.sessionId,
        'session.stream',
        {
          type: 'input_applied',
          inputId: queued.inputId,
          requestId: queued.requestId,
          priority: 'next',
          turn: 1,
          sessionId: context.claim.route.sessionId,
        },
        queued.requestId,
      );
      await this.publish(
        context.claim.route.tenantId,
        context.claim.route.sessionId,
        'session.stream',
        {
          type: 'turn_start',
          turn: 1,
          sessionId: context.claim.route.sessionId,
        },
        queued.requestId,
      );
      const result = await host.exec(execution.executionId, {
        command: '/bin/sh',
        args: ['-c', 'printf "Docker worker received: "; cat'],
        stdin: queued.input,
        signal: context.signal,
      });
      const output = result.stdout.trim();
      if (result.exitCode !== 0) {
        await this.publishFailure(context, queued.requestId, result.stderr.trim());
        return {
          status: 'idle',
          metadata: {
            ...metadata,
            lastExecution: {
              requestId: queued.requestId,
              exitCode: result.exitCode,
              completedAt: result.completedAt,
            },
          },
        };
      }
      await this.publish(
        context.claim.route.tenantId,
        context.claim.route.sessionId,
        'session.stream',
        {
          type: 'content',
          delta: output,
          sessionId: context.claim.route.sessionId,
        },
        queued.requestId,
      );
      await this.publish(
        context.claim.route.tenantId,
        context.claim.route.sessionId,
        'session.stream',
        {
          type: 'result',
          subtype: 'success',
          content: output,
          sessionId: context.claim.route.sessionId,
        },
        queued.requestId,
      );
      return {
        status: 'idle',
        metadata: {
          ...metadata,
          lastExecution: {
            requestId: queued.requestId,
            exitCode: result.exitCode,
            completedAt: result.completedAt,
          },
        },
      };
    } catch (error) {
      if (!context.signal.aborted) {
        await this.publishFailure(
          context,
          queued.requestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      await host.terminate(execution.executionId).catch(() => undefined);
    }
  }

  async publishFailure(context, requestId, message) {
    const error = message || 'Docker execution failed';
    await this.publish(
      context.claim.route.tenantId,
      context.claim.route.sessionId,
      'session.stream',
      {
        type: 'error',
        message: error,
        sessionId: context.claim.route.sessionId,
      },
      requestId,
    );
    await this.publish(
      context.claim.route.tenantId,
      context.claim.route.sessionId,
      'session.stream',
      {
        type: 'result',
        subtype: 'error',
        error,
        sessionId: context.claim.route.sessionId,
      },
      requestId,
    );
  }
}
