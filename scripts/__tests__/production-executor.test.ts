import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProtocolError } from '../../src/protocol/index.js';
import { assertSessionExecutorReadResult } from '../../src/server/testing/index.js';

type Submission = { inputId: string; requestId: string; status: string };
type Context = { principal: { tenantId: string; subject: string }; commandId: string };
type Input = { sessionId: string; input: unknown; maxTurns?: number; expectedRequestId?: string };
type PermissionInput = { sessionId: string; permissionRequestId: string; approved: boolean; scope?: string; reason?: string };
type RecordData = Record<string, unknown>;
type Route = { state: string; metadata: RecordData };
interface Executor {
  create(context: Context, data: RecordData): Promise<RecordData>;
  read(context: Context, data: { sessionId: string }): Promise<RecordData>;
  submit(context: Context, data: Input): Promise<Submission & { sessionId: string }>;
  abort(context: Context, data: { sessionId: string }): Promise<void>;
  closeSession(context: Context, data: { sessionId: string }): Promise<RecordData>;
  resolvePermission(context: Context, data: PermissionInput): Promise<void>;
  shutdown(): Promise<void>;
}

// Run the shipped example while replacing only imports. These tests exercise
// control-flow contracts; PostgreSQL locking and Worker recovery are covered by
// the separate real production smoke path.
function exampleClass<T>(file: string, name: string, imports: RecordData): T {
  const source = readFileSync(resolve('examples/production-stack', file), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/^export /gm, '');
  return runInNewContext(`${source}\n${name}`, {
    randomUUID,
    isDeepStrictEqual,
    AgentProtocolError,
    process: { pid: process.pid },
    Date,
    setTimeout,
    clearTimeout,
    ...imports,
  }, { filename: file }) as T;
}

const context: Context = {
  principal: { tenantId: 'tenant-1', subject: 'user-1' },
  commandId: 'command-1',
};
const input = { sessionId: 'session-1', input: 'Inspect the repository' };
const queued = (requestId = 'request-1'): RecordData => ({
  bladeQueuedRequest: { input: input.input, inputId: `input-${requestId}`, requestId },
});

function harness() {
  const trace: string[] = [];
  const control = {
    sendGate: undefined as Promise<void> | undefined,
    detachGate: undefined as Promise<void> | undefined,
    sendError: undefined as Error | undefined,
    detachError: undefined as Error | undefined,
  };
  let requestCount = 0;
  const handles: ReturnType<typeof handle>[] = [];
  function handle() {
    const session = {
      sessionId: 'session-1',
      send: vi.fn(async (_input: unknown, _options?: RecordData): Promise<Submission> => {
        trace.push('send');
        await control.sendGate;
        if (control.sendError) throw control.sendError;
        requestCount += 1;
        return { inputId: `input-${requestCount}`, requestId: `request-${requestCount}`, status: 'started' };
      }),
      suspendForHandoff: vi.fn(async () => {
        trace.push('detaching');
        await control.detachGate;
        if (control.detachError) throw control.detachError;
        trace.push('detached');
      }),
      close: vi.fn(async () => { trace.push('closed'); }),
      stream: vi.fn(),
    };
    handles.push(session);
    return session;
  }
  const createSession = vi.fn(async (_options: RecordData) => { trace.push('create'); return handle(); });
  const resumeSession = vi.fn(async (_options: RecordData) => { trace.push('resume'); return handle(); });
  const record = { tenantId: 'tenant-1', createdBy: 'user-1', sessionId: 'session-1', status: 'active', metadata: {} };
  const snapshot = { messages: [{ role: 'user', content: 'Earlier task' }], pendingInputs: [] };
  const tenantStore = { loadState: vi.fn(async () => snapshot) };
  const store = {
    route: null as Route | null,
    forTenant: vi.fn((_tenantId: string) => tenantStore),
    putSession: vi.fn(async (value: typeof record) => { trace.push('session-record'); Object.assign(record, value); }),
    getSession: vi.fn(async (tenantId: string, sessionId: string) =>
      tenantId === record.tenantId && sessionId === record.sessionId ? record : null),
    getSessionRoute: vi.fn(async () => store.route),
    enqueueSession: vi.fn(async (_tenantId: string, _sessionId: string, options: { metadata: RecordData }) => {
      trace.push('enqueue');
      store.route = { state: 'queued', metadata: options.metadata };
    }),
  };
  const cancellations = new Map<string, { status: string; cleanup: string; cleanupDetail?: string }>();
  const state = {
    permission: { requestId: 'request-1', status: 'pending' },
    update: vi.fn(async (_sessionId: string, patch: RecordData) => { trace.push('submission-record'); return patch; }),
    requestCancel: vi.fn(async (_sessionId: string, requestId: string) => {
      if (!cancellations.has(requestId)) {
        cancellations.set(requestId, { status: 'requested', cleanup: 'pending' });
      }
      return cancellations.get(requestId);
    }),
    recordCancellationCleanup: vi.fn(async (_sessionId: string, requestId: string, outcome: RecordData) => {
      const cancellation = cancellations.get(requestId);
      if (cancellation) cancellation.cleanup = outcome.succeeded ? 'stopped' : 'failed';
    }),
    getCancellation: vi.fn(async (_sessionId: string, requestId: string) => cancellations.get(requestId)),
    markCancelled: vi.fn(async (_sessionId: string, requestId: string) => {
      const cancellation = cancellations.get(requestId);
      if (cancellation) cancellation.status = 'completed';
    }),
    // Durable acceptance bookkeeping the submit path now uses.
    pendingSubmissions: new Map<string, RecordData>(),
    recordSubmissionAccepted: vi.fn(async (record: RecordData) => {
      trace.push('submission-accepted');
      const key = String((record as { sessionId?: unknown }).sessionId);
      if (!state.pendingSubmissions.has(key)) state.pendingSubmissions.set(key, record);
    }),
    markSubmissionQueued: vi.fn(async (sessionId: string) => {
      state.pendingSubmissions.delete(String(sessionId));
    }),
    getPendingSubmission: vi.fn(async (sessionId: string) => {
      const record = state.pendingSubmissions.get(String(sessionId));
      // The real store flattens the accepted input into `value`; mirror that shape.
      return record ? { ...record, value: { ...(record.value as RecordData), input: record.input } } : null;
    }),
    recordOutcomePending: vi.fn(async () => undefined),
    markOutcomePublished: vi.fn(async () => undefined),
    getUnpublishedOutcome: vi.fn(async () => null),
    listPendingSubmissions: vi.fn(async () => []),
    listUnpublishedOutcomes: vi.fn(async () => []),
    getPermission: vi.fn(async () => state.permission),
    isCancelled: vi.fn(async (_sessionId: string, requestId: string) => cancellations.has(requestId)),
    resolvePermission: vi.fn(async (_sessionId: string, _requestId: string, _permissionId: string, _decision: RecordData) => {
      if (state.permission.status !== 'pending') {
        throw new AgentProtocolError('PERMISSION_NOT_FOUND', 'Already resolved', 404);
      }
      state.permission.status = 'resolved';
    }),
  };
  const publish = vi.fn(async () => { trace.push('published'); });
  const Constructor = exampleClass<new (...args: unknown[]) => Executor>(
    'QueuedSessionExecutor.mjs', 'QueuedSessionExecutor', {
      createSession,
      resumeSession,
      createRepositorySessionOptions: () => ({ provider: { type: 'openai' }, model: 'test', tools: [] }),
    },
  );
  const executor = new Constructor(store, publish, { state, smoke: true });
  return { executor, store, state, cancellations, context, trace, control, handles, createSession, resumeSession, record, snapshot, tenantStore, publish };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('production QueuedSessionExecutor', () => {
  it('creates a durable SDK Session and detaches it without running a model', async () => {
    const test = harness();
    const result = await test.executor.create(context, { metadata: { source: 'test' } });
    expect(result).toMatchObject({ sessionId: 'session-1', tenantId: 'tenant-1', status: 'active' });
    expect(test.trace).toEqual(['create', 'session-record', 'detaching', 'detached']);
    expect(test.createSession.mock.calls[0]?.[0]).toMatchObject({
      sessionRepository: test.tenantStore,
      sessionEventStore: test.tenantStore,
      durableEventStore: test.tenantStore,
      executionLease: { ownerId: `production-api-${process.pid}`, leaseId: expect.any(String), ttlMs: 15_000 },
    });
    expect(test.handles[0]?.stream).not.toHaveBeenCalled();
  });

  it('persists SDK acceptance and releases its fence before making the request claimable', async () => {
    const test = harness();
    let detach!: () => void;
    test.control.detachGate = new Promise<void>((resolve) => { detach = resolve; });
    const submitted = test.executor.submit(context, { ...input, maxTurns: 5 });
    await flush();
    // The durable acceptance record comes before the projection update: the
    // recovery sweep must find it, and a crash in between is rebuilt from the
    // Session journal.
    expect(test.state.recordSubmissionAccepted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      requestId: 'request-1',
      input: input.input,
      value: { status: 'started', requestId: 'request-1', inputId: 'input-1',
        input: input.input, commandId: 'command-1', maxTurns: 5 },
    });
    expect(test.state.update).toHaveBeenCalledWith('session-1', {
      submission: { status: 'started', requestId: 'request-1', inputId: 'input-1',
        input: input.input, commandId: 'command-1', maxTurns: 5 },
    });
    expect(test.store.enqueueSession).not.toHaveBeenCalled();
    detach();
    expect(await submitted).toMatchObject({ requestId: 'request-1', inputId: 'input-1', status: 'started' });
    expect(test.trace).toEqual([
      'resume', 'send', 'submission-accepted', 'submission-record', 'detaching', 'detached', 'enqueue',
    ]);
    expect(test.handles[0]?.send).toHaveBeenCalledWith(input.input, { maxTurns: 5 });
    expect(test.handles[0]?.stream).not.toHaveBeenCalled();
  });

  it('accepts the next round with a new API fence and retains the workspace checkpoint', async () => {
    const test = harness();
    await test.executor.submit(context, input);
    test.store.route = { state: 'idle', metadata: { ...queued(), workspaceCheckpoint: { checkpointId: 'checkpoint-1' } } };
    const second = await test.executor.submit({ ...context, commandId: 'command-2' }, { ...input, input: 'Follow up' });
    expect(second.requestId).toBe('request-2');
    const firstOptions = test.resumeSession.mock.calls[0]?.[0];
    const secondOptions = test.resumeSession.mock.calls[1]?.[0];
    expect(firstOptions?.executionLease).not.toEqual(secondOptions?.executionLease);
    expect(secondOptions?.sessionRepository).toBe(test.tenantStore);
    expect(test.store.route?.metadata.workspaceCheckpoint).toEqual({ checkpointId: 'checkpoint-1' });
    expect(test.store.route?.metadata.bladeQueuedRequest).toMatchObject({ requestId: 'request-2', input: 'Follow up' });
    expect(test.handles.every((session) => session.suspendForHandoff.mock.calls.length === 1)).toBe(true);
  });

  it('serializes simultaneous submissions so only one starts while the route is active', async () => {
    const test = harness();
    let accept!: () => void;
    test.control.sendGate = new Promise<void>((resolve) => { accept = resolve; });
    const first = test.executor.submit(context, input);
    const second = test.executor.submit({ ...context, commandId: 'command-2' }, { ...input, input: 'Conflicting request' });
    const rejected = expect(second).rejects.toMatchObject({ protocolCode: 'SESSION_CONFLICT' });
    await flush();
    expect(test.resumeSession).toHaveBeenCalledTimes(1);
    accept();
    await first;
    await rejected;
    expect(test.store.enqueueSession).toHaveBeenCalledTimes(1);
  });

  it('records the acceptance before anything else can fail after the journal write', async () => {
    const test = harness();
    await test.executor.submit(context, input);
    // The durable acceptance record must exist before the projection update:
    // a crash between the Session journal write and the record is rebuilt from
    // the journal, but the record is what the submit path itself must leave
    // first when it survives.
    expect(test.trace.indexOf('submission-accepted')).toBeGreaterThan(-1);
    expect(test.trace.indexOf('submission-accepted'))
      .toBeLessThan(test.trace.indexOf('submission-record'));
    expect(test.state.recordSubmissionAccepted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      requestId: 'request-1',
      input: 'Inspect the repository',
      value: expect.objectContaining({
        requestId: 'request-1',
        input: 'Inspect the repository',
        commandId: 'command-1',
      }),
    });
  });

  it('re-enqueues a pending record only when the retried command is identical', async () => {
    const test = harness();
    test.state.pendingSubmissions.set('session-1', {
      sessionId: 'session-1',
      requestId: 'request-1',
      input: 'Inspect the repository',
      value: {
        status: 'started',
        inputId: 'input-1',
        requestId: 'request-1',
        input: 'Inspect the repository',
        commandId: 'command-1',
      },
    });
    const result = await test.executor.submit(context, input);
    expect(result).toEqual({
      sessionId: 'session-1',
      status: 'started',
      inputId: 'input-1',
      requestId: 'request-1',
      input: 'Inspect the repository',
      commandId: 'command-1',
    });
    expect(test.resumeSession).not.toHaveBeenCalled();
    expect(test.store.enqueueSession).toHaveBeenCalledTimes(1);
    expect((test.store.route as Route)?.metadata?.bladeQueuedRequest).toMatchObject({
      requestId: 'request-1',
      input: 'Inspect the repository',
    });
  });

  it.each([
    { label: 'a different input', input: 'Completely different request', commandId: 'command-1' },
    { label: 'a different command', input: 'Inspect the repository', commandId: 'command-2' },
    { label: 'different execution options', input: 'Inspect the repository', commandId: 'command-1', maxTurns: 8 },
  ])('rejects a new submission for %s while recovery is pending', async ({ input: nextInput, commandId, maxTurns }) => {
    const test = harness();
    test.state.pendingSubmissions.set('session-1', {
      sessionId: 'session-1',
      requestId: 'request-1',
      input: 'Inspect the repository',
      value: {
        status: 'started',
        inputId: 'input-1',
        requestId: 'request-1',
        input: 'Inspect the repository',
        commandId: 'command-1',
      },
    });
    await expect(test.executor.submit({ ...context, commandId }, {
      sessionId: 'session-1',
      input: nextInput,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    })).rejects.toMatchObject({
      protocolCode: 'SESSION_CONFLICT',
      message: expect.stringContaining('different submission'),
    });
    expect(test.resumeSession).not.toHaveBeenCalled();
    expect(test.store.enqueueSession).not.toHaveBeenCalled();
  });

  it('confirms a retry whose submission a crashed attempt already enqueued', async () => {
    const test = harness();
    test.store.route = { state: 'queued', metadata: queued('request-1') };
    test.state.pendingSubmissions.set('session-1', {
      sessionId: 'session-1',
      requestId: 'request-1',
      input: 'Inspect the repository',
      value: {
        status: 'started',
        inputId: 'input-1',
        requestId: 'request-1',
        input: 'Inspect the repository',
        commandId: 'command-1',
      },
    });
    const result = await test.executor.submit(context, input);
    expect(result).toMatchObject({ requestId: 'request-1', input: 'Inspect the repository' });
    expect(test.resumeSession).not.toHaveBeenCalled();
    expect(test.store.enqueueSession).not.toHaveBeenCalled();
  });

  it('detaches failed submissions and never queues a request whose handoff failed', async () => {
    const test = harness();
    test.control.sendError = new Error('Input was not accepted');
    await expect(test.executor.submit(context, input)).rejects.toThrow('Input was not accepted');
    expect(test.handles[0]?.suspendForHandoff).toHaveBeenCalledTimes(1);
    expect(test.store.enqueueSession).not.toHaveBeenCalled();
    test.control.sendError = undefined;
    test.control.detachError = new Error('The fence could not be released');
    await expect(test.executor.submit(context, input)).rejects.toThrow('The fence could not be released');
    expect(test.store.enqueueSession).not.toHaveBeenCalled();
  });

  it('reads the tenant transcript projection and rejects cross-tenant submissions', async () => {
    const test = harness();
    const read = await test.executor.read(context, { sessionId: 'session-1' });
    // The shipped example must satisfy the same read contract as the SDK's own
    // executors: the server reads `loaded` to decide whether the pending-input
    // projection is known, so omitting it silently weakens the recovery snapshot.
    assertSessionExecutorReadResult(read as never, 'QueuedSessionExecutor.read');
    expect(read).toMatchObject({ loaded: true });
    expect(read.messages).toEqual(test.snapshot.messages);
    expect(test.tenantStore.loadState).toHaveBeenCalledWith('session-1');
    await expect(test.executor.submit({ ...context, principal: { tenantId: 'other-tenant', subject: 'other-user' } }, input))
      .rejects.toMatchObject({ protocolCode: 'SESSION_NOT_FOUND' });
    expect(test.resumeSession).not.toHaveBeenCalled();
  });

  it('accepts only once-scoped decisions for the current pending request', async () => {
    const test = harness();
    test.store.route = { state: 'waiting_approval', metadata: queued() };
    const decision = { sessionId: 'session-1', permissionRequestId: 'permission-1', approved: true };
    await expect(test.executor.resolvePermission(context, { ...decision, scope: 'session' }))
      .rejects.toMatchObject({ protocolCode: 'INVALID_COMMAND' });
    expect(test.state.resolvePermission).not.toHaveBeenCalled();
    await test.executor.resolvePermission(context, { ...decision, scope: 'once', reason: 'Reviewed' });
    expect(test.state.resolvePermission).toHaveBeenCalledWith('session-1', 'request-1', 'permission-1', {
      approved: true, scope: 'once', reason: 'Reviewed',
    });
    await expect(test.executor.resolvePermission(context, { ...decision, approved: false }))
      .rejects.toMatchObject({ protocolCode: 'PERMISSION_NOT_FOUND' });
    expect(test.state.resolvePermission).toHaveBeenCalledTimes(1);
  });

  it.each(['old-request', 'cancelled', 'idle'] as const)('rejects an approval after %s', async (reason) => {
    const test = harness();
    test.store.route = { state: reason === 'idle' ? 'idle' : 'running', metadata: queued() };
    if (reason === 'old-request') test.state.permission.requestId = 'request-old';
    if (reason === 'cancelled') test.cancellations.set('request-1', { status: 'requested' });
    await expect(test.executor.resolvePermission(context, {
      sessionId: 'session-1', permissionRequestId: 'permission-1', approved: true,
    })).rejects.toMatchObject({ protocolCode: 'PERMISSION_NOT_FOUND' });
    expect(test.state.resolvePermission).not.toHaveBeenCalled();
  });

  it('keeps duplicate cancellation commands pending until the Worker acknowledges the shared intent', async () => {
    vi.useFakeTimers();
    const test = harness();
    test.store.route = { state: 'running', metadata: queued() };
    let acknowledged = 0;
    const cancel = test.executor.abort(context, input).then(() => { acknowledged += 1; });
    const duplicate = test.executor.abort({ ...context, commandId: 'command-2' }, input).then(() => { acknowledged += 1; });
    await vi.advanceTimersByTimeAsync(60_500);
    expect(acknowledged).toBe(0);
    expect(test.cancellations.size).toBe(1);
    test.cancellations.set('request-1', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([cancel, duplicate]);
    expect(acknowledged).toBe(2);
  });

  it.each(['idle', 'completed', 'failed'])('acknowledges cancellation when execution reaches %s', async (terminal) => {
    vi.useFakeTimers();
    const test = harness();
    test.store.route = { state: 'running', metadata: queued() };
    let acknowledged = false;
    const cancelled = test.executor.abort(context, input).then(() => { acknowledged = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(acknowledged).toBe(false);
    test.store.route.state = terminal;
    await vi.advanceTimersByTimeAsync(50);
    // A finished route alone is not enough: the execution environment must be
    // confirmed stopped, which the runner records separately.
    expect(acknowledged).toBe(false);
    test.cancellations.get('request-1')!.cleanup = 'stopped';
    await vi.advanceTimersByTimeAsync(50);
    expect(acknowledged).toBe(true);
    await cancelled;
    expect(test.state.markCancelled).toHaveBeenCalledWith('session-1', 'request-1');
    expect(test.cancellations.get('request-1')?.status).toBe('completed');
  });

  it('refuses to confirm cancellation when the execution environment was not stopped', async () => {
    vi.useFakeTimers();
    const test = harness();
    test.store.route = { state: 'running', metadata: queued() };
    // Attach the handler before the rejection happens, otherwise the rejected
    // promise counts as unhandled while the fake timers are advanced.
    const settled = test.executor.abort(context, input).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(50);
    test.store.route.state = 'failed';
    test.cancellations.get('request-1')!.cleanup = 'failed';
    test.cancellations.get('request-1')!.cleanupDetail = 'docker rm failed';
    await vi.advanceTimersByTimeAsync(50);
    await expect(settled).resolves.toMatchObject({
      protocolCode: 'SESSION_CONFLICT',
      message: expect.stringContaining('docker rm failed'),
    });
    expect(test.state.markCancelled).not.toHaveBeenCalled();
  });
});

describe('production RepositoryState permission binding', () => {
  function stateHarness() {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const Constructor = exampleClass<new (options: RecordData) => {
      requestPermission(options: RecordData): Promise<RecordData>;
      getPermission(sessionId: string, permissionId: string): Promise<RecordData>;
      resolvePermission(sessionId: string, requestId: string, permissionId: string, decision: RecordData): Promise<void>;
    }>('RepositoryState.mjs', 'RepositoryState', { pg: { Pool: class { query = query; } } });
    const state = new Constructor({ connectionString: 'postgres://unused', schema: 'test_schema' });
    const request = { toolName: 'RepoWrite', input: { path: 'report.md', content: 'Reviewed content' } };
    const record = { requestId: 'request-1', request, status: 'resolved', decision: { approved: true, scope: 'once' } };
    state.getPermission = vi.fn(async () => record);
    const options = { sessionId: 'session-1', requestId: 'request-1', permissionRequestId: 'permission-1', request };
    return { state, record, request, options, query };
  }

  it('reuses the existing decision only for the same tool and equivalent input', async () => {
    const test = stateHarness();
    const result = await test.state.requestPermission({
      ...test.options,
      request: { toolName: 'RepoWrite', input: { content: 'Reviewed content', path: 'report.md' } },
    });
    expect(result).toEqual(test.record);
    expect(test.query.mock.calls[0]?.[1]).toEqual([
      'session-1', 'permission-1', 'request-1',
      JSON.stringify({ toolName: 'RepoWrite', input: { content: 'Reviewed content', path: 'report.md' } }),
    ]);
  });

  it.each(['tool', 'input', 'request'] as const)('rejects reused permission IDs when the %s changes', async (changed) => {
    const test = stateHarness();
    const request = {
      toolName: changed === 'tool' ? 'RepoDelete' : 'RepoWrite',
      input: { path: 'report.md', content: changed === 'input' ? 'Unreviewed replacement' : 'Reviewed content' },
    };
    await expect(test.state.requestPermission({
      ...test.options,
      requestId: changed === 'request' ? 'request-2' : 'request-1',
      request,
    })).rejects.toThrow('Permission ID cannot be reused');
  });

  it('rejects decisions after the pending permission has already been consumed or retired', async () => {
    const test = stateHarness();
    test.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(test.state.resolvePermission('session-1', 'request-1', 'permission-1', { approved: true, scope: 'once' }))
      .rejects.toMatchObject({ protocolCode: 'PERMISSION_NOT_FOUND' });
  });
});
