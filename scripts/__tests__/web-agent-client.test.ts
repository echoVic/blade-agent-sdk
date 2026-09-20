import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AgentProtocolError, parseAgentEventCursor } from '../../src/protocol/index.js';

type Listener = (event: { preventDefault(): void; persisted?: boolean }) => unknown;

// Exercise the shipped page script without a browser dependency. The DOM double
// deliberately models only the elements and events used by this small example.
// Task 7's fix round moved rendering from replaceChildren()-every-time to
// incremental append()/remove(), so this double now tracks a parent per
// element (the shipped client only ever appends to one fixed parent at a
// time or detaches-then-reattaches to the same one; it never reparents a
// node between two different containers).
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = '';
  disabled = false;
  hidden = false;
  open = false;
  value = '';
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  private text = '';
  private listeners = new Map<string, Listener[]>();

  constructor(readonly tagName = 'div') {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.text = String(value ?? '');
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  append(...children: Element[]): void {
    for (const child of children) {
      child.remove();
      child.parent = this;
    }
    this.children.push(...children);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  replaceChildren(...children: Element[]): void {
    this.text = '';
    for (const child of this.children) child.parent = null;
    this.children = children;
    for (const child of children) child.parent = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, details: { persisted?: boolean } = {}): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) {
      void listener({ preventDefault() {}, ...details });
    }
  }

  setAttribute(name: string, value: string): void {
    if (name === 'class') this.className = value;
  }

  focus(): void {}
}

type EventData = {
  protocolVersion: number;
  eventId: string;
  sequence: number;
  occurredAt: string;
  sessionId: string;
  requestId?: string;
  type: string;
  data: Record<string, unknown>;
};

class EventStream {
  private pending: (EventData | Error)[] = [];
  private wake?: () => void;

  push(...events: EventData[]): void {
    this.pending.push(...events);
    this.wake?.();
  }

  fail(error: Error): void {
    this.pending.push(error);
    this.wake?.();
  }

  async *read(signal?: AbortSignal): AsyncGenerator<EventData> {
    const onAbort = (): void => this.wake?.();
    signal?.addEventListener('abort', onAbort);
    try {
      while (!signal?.aborted) {
        if (this.pending.length === 0) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          this.wake = undefined;
          continue;
        }
        const next = this.pending.shift();
        if (next instanceof Error) throw next;
        if (next) yield next;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

type EventOptions = {
  after?: { protocolVersion: number; eventId: string; sessionId: string; sequence: number } | null;
  signal?: AbortSignal;
};

// Shape of what the server hands back for SESSION_READ, trimmed to the fields
// hydrateFromServer() actually reads (src/model/message.ts's ModelMessage).
type HistoryMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};

// What session.send() resolves to for a priority submission (steering), mirroring
// InputSubmission from src/session/types.ts minus the sessionId the mock injects.
type SteerResult =
  | { status: 'started'; inputId: string; requestId: string }
  | { status: 'steered'; inputId: string; requestId: string; priority: 'now' | 'next' }
  | { status: 'queued'; inputId: string; priority: 'later' };

class Backend {
  createCalls = 0;
  createCommandIds: (string | undefined)[] = [];
  resumeCalls: string[] = [];
  sendCalls: { sessionId: string; input: string; commandId?: string; priority?: string }[] = [];
  sendResults: ({ sessionId: string } & SteerResult)[] = [];
  /** Consumed once by the next priority send; falls back to a plain "steered" reply. */
  nextSendResult?: SteerResult;
  lastRequestId?: string;
  /** SESSION_READ's messages, consulted by hydrateFromServer() after a resume. */
  historyMessages: HistoryMessage[] = [];
  abortCalls: string[] = [];
  abortCommandIds: (string | undefined)[] = [];
  permissionCalls: {
    sessionId: string;
    permissionRequestId: string;
    response: { approved: boolean; scope: string };
    commandId?: string;
  }[] = [];
  readCalls: string[] = [];
  closeCalls: string[] = [];
  eventCalls: { sessionId: string; options: EventOptions; stream: EventStream }[] = [];
  resumeError?: Error;
  createError?: Error;
  sendError?: Error;
  abortError?: Error;
  permissionError?: Error;
  permissionGate?: Promise<void>;
  abortGate?: Promise<void>;
  sessionStatus: 'active' | 'closed' = 'active';
  loseNextSendResponse = false;
  loseNextPermissionResponse = false;
  private requests = new Map<string, string>();

  session(sessionId: string) {
    return {
      sessionId,
      send: async (
        input: string,
        options: { commandId?: string; priority?: 'now' | 'next' | 'later' } = {},
      ) => {
        this.sendCalls.push({
          sessionId,
          input,
          commandId: options.commandId,
          priority: options.priority,
        });
        if (this.sendError) throw this.sendError;
        if (this.loseNextSendResponse) {
          this.loseNextSendResponse = false;
          throw new TypeError('Failed to fetch after the server accepted the input');
        }
        let outcome: SteerResult;
        if (options.priority) {
          // A priority submission (steering) folds into the active request by
          // default; a test overrides nextSendResult to model queued/started instead.
          const override = this.nextSendResult;
          this.nextSendResult = undefined;
          outcome = override ?? {
            status: 'steered',
            inputId: `steer-${this.sendCalls.length}`,
            requestId: this.lastRequestId ?? 'request-1',
            priority: 'now',
          };
        } else {
          const key = options.commandId ?? `submission-${this.sendCalls.length}`;
          let requestId = this.requests.get(key);
          if (!requestId) {
            requestId = `request-${this.requests.size + 1}`;
            this.requests.set(key, requestId);
          }
          this.lastRequestId = requestId;
          outcome = { status: 'started', inputId: `input-${requestId}`, requestId };
        }
        const response = { sessionId, ...outcome };
        this.sendResults.push(response);
        return response;
      },
      events: (options: EventOptions = {}) => {
        if (options.after) parseAgentEventCursor(options.after);
        const stream = new EventStream();
        this.eventCalls.push({ sessionId, options, stream });
        return stream.read(options.signal);
      },
      abort: async (options: { commandId?: string } = {}) => {
        this.abortCalls.push(sessionId);
        this.abortCommandIds.push(options.commandId);
        const error = this.abortError;
        await this.abortGate;
        if (error) throw error;
      },
      close: async () => {
        this.closeCalls.push(sessionId);
      },
      read: async () => ({
        session: { sessionId, status: this.sessionStatus },
        messages: this.historyMessages,
        pendingInputs: [],
      }),
    };
  }

  clientClass() {
    const backend = this;
    return class AgentClient {
      async createSession(_metadata = {}, options: { commandId?: string } = {}) {
        backend.createCommandIds.push(options.commandId);
        if (backend.createError) throw backend.createError;
        return backend.session(`session-${++backend.createCalls}`);
      }

      async resumeSession(sessionId: string) {
        backend.resumeCalls.push(sessionId);
        if (backend.resumeError) throw backend.resumeError;
        return backend.session(sessionId);
      }

      async readSession(sessionId: string) {
        backend.readCalls.push(sessionId);
        return backend.session(sessionId).read();
      }

      async resolvePermission(
        sessionId: string,
        permissionRequestId: string,
        response: { approved: boolean; scope: string },
        options: { commandId?: string } = {},
      ) {
        backend.permissionCalls.push({
          sessionId,
          permissionRequestId,
          response,
          commandId: options.commandId,
        });
        const error = backend.permissionError;
        await backend.permissionGate;
        if (error) throw error;
        if (backend.loseNextPermissionResponse) {
          backend.loseNextPermissionResponse = false;
          throw new TypeError('The approval response was lost');
        }
      }
    };
  }

  latestStream(): EventStream {
    const call = this.eventCalls.at(-1);
    if (!call) throw new Error('The page has not subscribed to Session events');
    return call.stream;
  }
}

function content(sequence: number, requestId: string, delta: string): EventData {
  return {
    protocolVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'session-1',
    requestId,
    type: 'session.stream',
    data: { type: 'content', delta, sessionId: 'session-1' },
  };
}

function result(sequence: number, requestId: string, subtype = 'success'): EventData {
  return {
    ...content(sequence, requestId, ''),
    data: { type: 'result', subtype, sessionId: 'session-1' },
  };
}

function permission(
  sequence: number,
  id = 'permission-1',
  requestId?: string,
  input: Record<string, unknown> = { path: 'report.md', content: 'Approved report' },
): EventData {
  return {
    ...content(sequence, 'request-1', ''),
    requestId,
    type: 'permission.requested',
    data: {
      permissionRequestId: id,
      toolName: 'WriteFile',
      input,
      title: 'Write the report?',
      message: 'The agent wants to save the report to your workspace.',
      affectedPaths: ['report.md'],
      risks: ['Replaces the existing report'],
    },
  };
}

function toolEvent(sequence: number, data: Record<string, unknown>): EventData {
  return { ...content(sequence, 'request-1', ''), data: { sessionId: 'session-1', ...data } };
}

function cursor(sequence: number) {
  return { protocolVersion: 1, sessionId: 'session-1', sequence, eventId: `event-${sequence}` };
}

// A hand-built localStorage snapshot that restore() accepts as-is, every
// field present -- so a test that wants one malformed field can override just
// that one instead of restating (and risking drifting from) the full shape
// emptyState() actually produces.
function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    sessionId: 'session-1',
    createCommandId: null,
    cursor: null,
    nodes: [],
    activeRequestId: null,
    pendingSubmission: null,
    cancelCommandId: null,
    pendingTerminal: null,
    pendingQueuedInputId: null,
    permissions: [],
    handledPermissionIds: [],
    retiredPermissionIds: [],
    lastStatus: 'Idle',
    ...overrides,
  };
}

function storageWith(snapshot: Record<string, unknown>): Map<string, string> {
  const storage = new Map<string, string>();
  storage.set('blade-web-session:v2', JSON.stringify(snapshot));
  return storage;
}

function protocolError(
  code:
    | 'SESSION_NOT_FOUND'
    | 'STALE_CURSOR'
    | 'SESSION_CONFLICT'
    | 'INVALID_COMMAND'
    | 'PERMISSION_NOT_FOUND',
  retryable = false,
): Error {
  return new AgentProtocolError(code, code, code === 'SESSION_NOT_FOUND' ? 404 : 409, retryable);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function openPage(backend: Backend, storage = new Map<string, string>()) {
  const elements = new Map<string, Element>();
  for (const id of [
    'prompt-form',
    'prompt',
    'timeline',
    'status',
    'notice',
    'announcer',
    'hint',
    'session-id',
    'submit',
    'cancel',
    'reconnect',
    'new-session',
  ])
    elements.set(id, new Element());
  const element = (id: string): Element => {
    const found = elements.get(id);
    if (!found) throw new Error(`Unknown element: ${id}`);
    return found;
  };
  const descendants = (parent: Element): Element[] =>
    parent.children.flatMap((child) => [child, ...descendants(child)]);
  // The timeline renders one flat list of typed nodes instead of separate
  // message/tool-activity lists; every article or <details> carries a fixed
  // 'node <kind>' class, which is how these helpers tell nodes apart.
  const nodesOfClass = (className: string) =>
    element('timeline').children.filter((child) => child.className === className);
  const approvalCards = () => nodesOfClass('node approval');
  const toolCards = () => nodesOfClass('node tool');
  // localStorage replaces the old sessionStorage, under the :v2 key for the node model.
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const windowEvents = new Element();
  const window = {
    location: { origin: 'http://localhost:8787' },
    localStorage,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
  };
  const source = readFileSync(resolve('examples/web-agent-server/client.js'), 'utf8').replace(
    /^import\s+\{\s*AgentClient\s*\}\s+from\s+['"][^'"]+['"];?\s*/m,
    '',
  );
  runInNewContext(
    source,
    {
      AgentClient: backend.clientClass(),
      document: {
        querySelector: (selector: string) => elements.get(selector.slice(1)) ?? null,
        createElement: (tag: string) => new Element(tag),
      },
      window,
      navigator: { onLine: true },
      localStorage,
      crypto: webcrypto,
      Error,
      TypeError,
      AbortController,
      AbortSignal,
      DOMException,
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
    },
    { filename: 'web-agent-client.js' },
  );

  return {
    storage,
    element,
    approvalCards,
    toolCards,
    steerEntries: () => nodesOfClass('node steer').map((node) => node.textContent),
    systemNotes: () => nodesOfClass('node system').map((node) => node.textContent),
    thinkingBlocks: () => nodesOfClass('node thinking'),
    announced: () => element('announcer').textContent,
    messages: () =>
      element('timeline')
        .children.filter(
          (node) => node.className === 'node user' || node.className === 'node assistant',
        )
        .map((node) => ({
          role: node.className === 'node user' ? 'user' : 'assistant',
          content: node.textContent,
        })),
    approvalDetailsOpen: (index = 0) => {
      const card = approvalCards()[index];
      const details = card && descendants(card).find((child) => child.tagName === 'details');
      return details?.open;
    },
    async submit(input: string) {
      element('prompt').value = input;
      element('prompt-form').dispatch('submit');
      await flush();
    },
    async click(id: string) {
      element(id).dispatch('click');
      await flush();
    },
    async decide(label: 'Approve once' | 'Approve for this session' | 'Deny', index = 0) {
      const card = approvalCards()[index];
      const button =
        card &&
        descendants(card).find(
          (child) => child.tagName === 'button' && child.textContent === label,
        );
      if (!button) throw new Error(`Approval button not found: ${label}`);
      button.dispatch('click');
      await flush();
    },
    async unload() {
      windowEvents.dispatch('pagehide');
      windowEvents.dispatch('beforeunload');
      await flush();
    },
    async restoreFromCache() {
      windowEvents.dispatch('pageshow', { persisted: true });
      await flush();
    },
  };
}

describe('Web Agent page behavior', () => {
  it('continues from the previous cursor and ignores results for other requests', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('First question');
    backend.latestStream().push(content(1, 'request-1', 'First answer'), result(2, 'request-1'));
    await flush();

    await page.submit('Second question');
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(2));
    backend
      .latestStream()
      .push(
        content(3, 'different-request', 'Do not display this'),
        result(4, 'different-request'),
        content(5, 'request-2', 'Second answer'),
        result(6, 'request-2'),
      );
    await flush();

    expect(page.messages()).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' },
    ]);
    expect(backend.createCalls).toBe(1);
    expect(page.element('submit').disabled).toBe(false);
  });

  it('restores a completed conversation after a page reload without resubmitting it', async () => {
    const backend = new Backend();
    const first = openPage(backend);
    await flush();
    await first.submit('Remember this');
    backend.latestStream().push(content(1, 'request-1', 'Remembered'), result(2, 'request-1'));
    await flush();
    const beforeReload = first.messages();
    await first.unload();

    const reloaded = openPage(backend, new Map(first.storage));
    await flush();
    expect(reloaded.messages()).toEqual(beforeReload);
    expect(reloaded.element('session-id').textContent).toBe('session-1');
    expect(backend.resumeCalls).toContain('session-1');
    expect(backend.sendCalls).toHaveLength(1);
    await reloaded.submit('Follow up');
    expect(backend.createCalls).toBe(1);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(2));
  });

  it('resumes an in-flight answer from its saved cursor after reload', async () => {
    const backend = new Backend();
    const first = openPage(backend);
    await flush();
    await first.submit('Long answer');
    backend.latestStream().push(content(1, 'request-1', 'Part one. '));
    await flush();
    const saved = new Map(first.storage);
    await first.unload();

    const reloaded = openPage(backend, saved);
    await flush();
    expect(backend.sendCalls).toHaveLength(1);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(1));
    backend.latestStream().push(content(2, 'request-1', 'Part two.'), result(3, 'request-1'));
    await flush();

    expect(reloaded.messages()).toEqual([
      { role: 'user', content: 'Long answer' },
      { role: 'assistant', content: 'Part one. Part two.' },
    ]);
    expect(reloaded.element('submit').disabled).toBe(false);
  });

  it('reconnects after exhausted transport retries without submitting or rendering twice', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Keep going');
    backend.latestStream().push(content(1, 'request-1', 'Before. '));
    backend.latestStream().fail(new Error('Network connection lost'));
    await flush();

    expect(page.messages().at(-1)?.content).toBe('Before. ');
    expect(page.element('reconnect').hidden).toBe(false);
    expect(page.element('reconnect').disabled).toBe(false);
    await page.click('reconnect');
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(1));
    backend.latestStream().push(content(2, 'request-1', 'After.'), result(3, 'request-1'));
    await flush();

    expect(page.messages().at(-1)?.content).toBe('Before. After.');
    expect(backend.sendCalls).toHaveLength(1);
    expect(page.element('submit').disabled).toBe(false);
  });

  it('shows cancellation feedback and retains the partial answer', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('A long task');
    backend.latestStream().push(content(1, 'request-1', 'Partial answer'));
    await flush();
    expect(page.element('cancel').disabled).toBe(false);
    expect(page.element('new-session').disabled).toBe(true);
    await page.click('new-session');
    expect(page.element('session-id').textContent).toBe('session-1');
    let acknowledgeAbort!: () => void;
    backend.abortGate = new Promise<void>((resolve) => {
      acknowledgeAbort = resolve;
    });
    await page.click('cancel');
    expect(backend.abortCalls).toEqual(['session-1']);
    expect(page.element('status').textContent).toMatch(/cancelling/i);
    // The input stays enabled even while cancelling -- task 7's whole point is
    // that the agent working (cancellation included) no longer locks the box.
    expect(page.element('submit').disabled).toBe(false);
    acknowledgeAbort();
    await flush();

    expect(page.element('status').textContent).toMatch(/cancel/i);
    expect(page.messages().at(-1)?.content).toBe('Partial answer');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.element('cancel').disabled).toBe(true);
  });

  it('retries an unacknowledged submission after reload with the original command ID', async () => {
    const backend = new Backend();
    backend.loseNextSendResponse = true;
    const first = openPage(backend);
    await flush();
    await first.submit('Submit only once');
    const commandId = backend.sendCalls[0]?.commandId;
    expect(commandId).toEqual(expect.any(String));
    const saved = new Map(first.storage);
    await first.unload();

    const reloaded = openPage(backend, saved);
    await flush();
    expect(backend.sendCalls).toHaveLength(2);
    expect(backend.sendCalls[1]).toMatchObject({ input: 'Submit only once', commandId });
    backend.latestStream().push(content(1, 'request-1', 'Accepted once'), result(2, 'request-1'));
    await flush();

    expect(reloaded.messages()).toEqual([
      { role: 'user', content: 'Submit only once' },
      { role: 'assistant', content: 'Accepted once' },
    ]);
  });

  it('keeps streaming after a definite cancellation rejection and uses a new ID for another attempt', async () => {
    const backend = new Backend();
    backend.abortError = protocolError('SESSION_CONFLICT', true);
    const page = openPage(backend);
    await flush();
    await page.submit('Finish this task');
    backend.latestStream().push(content(1, 'request-1', 'Still '));
    await flush();

    await page.click('cancel');
    expect(page.element('notice').textContent).toMatch(/cancellation was not accepted/i);
    expect(page.element('status').textContent).toBe('Working');
    expect(page.element('cancel').disabled).toBe(false);
    // Still an active request at this point, but no longer blocked -- the input
    // stays enabled (task 7), unlike the old client which locked it on hasRequest().
    expect(page.element('submit').disabled).toBe(false);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(1));

    await page.click('cancel');
    expect(backend.abortCommandIds).toHaveLength(2);
    expect(backend.abortCommandIds[0]).toEqual(expect.any(String));
    expect(backend.abortCommandIds[1]).not.toBe(backend.abortCommandIds[0]);
    backend.latestStream().push(content(2, 'request-1', 'working'), result(3, 'request-1'));
    await flush();

    expect(page.messages().at(-1)?.content).toBe('Still working');
    expect(page.element('status').textContent).toBe('Idle');
    expect(page.element('submit').disabled).toBe(false);
    expect(backend.sendCalls).toHaveLength(1);
  });

  it('settles a result received while cancellation is awaiting a definite rejection', async () => {
    const backend = new Backend();
    backend.abortError = protocolError('SESSION_CONFLICT', true);
    let releaseAbort!: () => void;
    backend.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const page = openPage(backend);
    await flush();
    await page.submit('Almost done');
    backend.latestStream().push(content(1, 'request-1', 'Completed answer'));
    await flush();
    await page.click('cancel');
    backend.latestStream().push(result(2, 'request-1'));
    await flush();
    expect(page.element('status').textContent).toBe('Cancelling');
    expect(page.element('submit').disabled).toBe(false);

    releaseAbort();
    await flush();
    expect(page.element('status').textContent).toBe('Idle');
    expect(page.element('notice').textContent).toMatch(/cancellation was not accepted/i);
    expect(page.element('submit').disabled).toBe(false);
    expect(page.messages().at(-1)?.content).toBe('Completed answer');
    await page.submit('Next task');
    expect(backend.sendCalls).toHaveLength(2);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(2));
  });

  it('reuses the cancellation command ID when a lost response is confirmed after reconnecting', async () => {
    const backend = new Backend();
    backend.abortError = new TypeError('Cancellation response was lost');
    const page = openPage(backend);
    await flush();
    await page.submit('Cancel after disconnect');
    backend.latestStream().push(content(1, 'request-1', 'Partial answer'));
    await flush();
    await page.click('cancel');
    expect(page.element('status').textContent).toBe('Disconnected');
    expect(page.element('submit').disabled).toBe(true);
    expect(page.element('reconnect').hidden).toBe(false);

    backend.abortError = undefined;
    await page.click('reconnect');
    expect(backend.abortCommandIds).toHaveLength(2);
    expect(backend.abortCommandIds[0]).toEqual(expect.any(String));
    expect(backend.abortCommandIds[1]).toBe(backend.abortCommandIds[0]);
    expect(page.element('status').textContent).toBe('Cancelled');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.messages().at(-1)?.content).toBe('Partial answer');
    expect(backend.sendCalls).toHaveLength(1);
  });

  it('restores the draft after a definite Session creation rejection and retries creation with a new ID', async () => {
    const backend = new Backend();
    backend.createError = protocolError('SESSION_CONFLICT', true);
    const page = openPage(backend);
    await flush();
    await page.submit('Create a session for this task');

    expect(page.element('status').textContent).toBe('Failed');
    expect(page.element('notice').textContent).toMatch(/message was not accepted/i);
    expect(page.element('prompt').value).toBe('Create a session for this task');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.element('reconnect').hidden).toBe(true);
    expect(backend.sendCalls).toHaveLength(0);
    expect(backend.createCommandIds[0]).toEqual(expect.any(String));

    backend.createError = undefined;
    await page.submit(page.element('prompt').value);
    expect(backend.createCommandIds).toHaveLength(2);
    expect(backend.createCommandIds[1]).not.toBe(backend.createCommandIds[0]);
    expect(backend.sendCalls).toHaveLength(1);
    expect(backend.sendCalls[0]?.input).toBe('Create a session for this task');
    backend.latestStream().push(content(1, 'request-1', 'Task started'), result(2, 'request-1'));
    await flush();
    expect(page.messages().at(-1)?.content).toBe('Task started');
    expect(page.element('submit').disabled).toBe(false);
  });

  it('restores editable input after a definite submission rejection and sends the correction with a new ID', async () => {
    const backend = new Backend();
    backend.sendError = protocolError('INVALID_COMMAND');
    const page = openPage(backend);
    await flush();
    await page.submit('Rejected question');

    expect(page.element('status').textContent).toBe('Failed');
    expect(page.element('notice').textContent).toMatch(/message was not accepted/i);
    expect(page.element('prompt').value).toBe('Rejected question');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.element('reconnect').hidden).toBe(true);
    const rejectedCommandId = backend.sendCalls[0]?.commandId;
    backend.sendError = undefined;
    await page.submit('Corrected question');
    expect(backend.sendCalls[1]?.commandId).not.toBe(rejectedCommandId);
    expect(backend.sendCalls[1]?.input).toBe('Corrected question');
    backend.latestStream().push(content(1, 'request-1', 'Accepted answer'), result(2, 'request-1'));
    await flush();
    expect(page.messages().at(-1)?.content).toBe('Accepted answer');
    expect(page.element('submit').disabled).toBe(false);
  });

  it('reconnects an in-flight stream when the same page returns from the back-forward cache', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Continue when I return');
    backend.latestStream().push(content(1, 'request-1', 'Before navigation. '));
    await flush();
    const firstConnection = backend.eventCalls.at(-1);
    await page.unload();
    expect(firstConnection?.options.signal?.aborted).toBe(true);

    await page.restoreFromCache();
    expect(backend.eventCalls).toHaveLength(2);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(1));
    backend
      .latestStream()
      .push(content(2, 'request-1', 'After returning.'), result(3, 'request-1'));
    await flush();
    expect(page.messages().at(-1)?.content).toBe('Before navigation. After returning.');
    expect(backend.sendCalls).toHaveLength(1);
    expect(page.element('submit').disabled).toBe(false);
  });

  it('offers a new Session when resume conflicts and the server snapshot says it is closed', async () => {
    const backend = new Backend();
    const first = openPage(backend);
    await flush();
    await first.submit('Saved task');
    backend.latestStream().push(content(1, 'request-1', 'Saved answer'), result(2, 'request-1'));
    await flush();
    const saved = new Map(first.storage);
    await first.unload();
    backend.resumeError = protocolError('SESSION_CONFLICT');
    backend.sessionStatus = 'closed';

    const reloaded = openPage(backend, saved);
    await flush();
    expect(backend.readCalls).toEqual(['session-1']);
    expect(reloaded.element('status').textContent).toBe('Unavailable');
    expect(reloaded.messages().at(-1)?.content).toBe('Saved answer');
    expect(reloaded.element('new-session').disabled).toBe(false);
    expect(reloaded.element('reconnect').hidden).toBe(true);
    await reloaded.click('new-session');
    await reloaded.submit('New task');
    expect(backend.sendCalls.at(-1)).toMatchObject({ sessionId: 'session-2', input: 'New task' });
  });

  it.each([
    'SESSION_NOT_FOUND',
    'STALE_CURSOR',
  ] as const)('preserves readable history and offers a new Session when recovery returns %s', async (code) => {
    const backend = new Backend();
    const first = openPage(backend);
    await flush();
    await first.submit('Saved question');
    backend.latestStream().push(content(1, 'request-1', 'Saved partial answer'));
    await flush();
    const saved = new Map(first.storage);
    await first.unload();
    if (code === 'SESSION_NOT_FOUND') backend.resumeError = protocolError(code);

    const reloaded = openPage(backend, saved);
    await flush();
    if (code === 'STALE_CURSOR') {
      backend.latestStream().fail(protocolError(code));
      await flush();
    }

    expect(reloaded.messages().at(-1)?.content).toBe('Saved partial answer');
    expect(reloaded.element('new-session').hidden).toBe(false);
    expect(reloaded.element('new-session').disabled).toBe(false);
    expect(reloaded.element('status').textContent).not.toBe('Idle');
    backend.resumeError = undefined;
    await reloaded.click('new-session');
    await reloaded.submit('Start again');
    expect(backend.sendCalls.at(-1)).toMatchObject({
      sessionId: 'session-2',
      input: 'Start again',
    });
  });

  it('renders a restored-from-disk note and rebuilds history when reopened with no local nodes', async () => {
    const backend = new Backend();
    backend.historyMessages = [
      { role: 'user', content: 'Analyze dependency risks' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'Glob', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'package.json' },
      { role: 'assistant', content: 'Dependency risk report' },
    ];
    // A fresh browser (or a cleared cache) that only knows the session id: no
    // locally cached timeline, so hydrateFromServer() must rebuild it from
    // SESSION_READ's messages rather than the usual localStorage round trip.
    const page = openPage(backend, storageWith(validSnapshot()));
    await flush();
    expect(backend.resumeCalls).toEqual(['session-1']);
    expect(page.systemNotes()).toContainEqual('Restored from disk, 4 messages');
    expect(page.messages()).toEqual([
      { role: 'user', content: 'Analyze dependency risks' },
      { role: 'assistant', content: 'Dependency risk report' },
    ]);
    expect(page.toolCards()).toHaveLength(1);
    expect(page.toolCards()[0]?.textContent).toContain('Glob');
    expect(page.toolCards()[0]?.textContent).toContain('Completed');
    expect(page.toolCards()[0]?.textContent).toContain('package.json');
    expect(page.element('submit').disabled).toBe(false);
  });

  it('falls back to a clean, persisted state and explains it when a saved node fails validation', async () => {
    // A tool node whose output is a number: real reproduction from the review
    // (renderTool did `node.output.split('\n')`, throwing inside the bootstrap
    // render with nothing shown and the same value repeating on every reload).
    const storage = storageWith(
      validSnapshot({
        nodes: [
          {
            id: 'n1',
            kind: 'tool',
            toolId: 't1',
            name: 'Bash',
            args: '',
            status: 'Running',
            summary: '',
            output: 5,
            startedAt: null,
            endedAt: null,
            open: false,
          },
        ],
      }),
    );
    const page = openPage(new Backend(), storage);
    await flush();
    expect(page.element('notice').textContent).toMatch(/could not be restored/i);
    expect(page.messages()).toEqual([]);
    expect(page.toolCards()).toHaveLength(0);
    expect(page.element('status').textContent).toBe('Idle');
    expect(page.element('session-id').textContent).toBe('Not started');
    // The bad value must not repeat on the next load.
    const persisted = JSON.parse(storage.get('blade-web-session:v2') ?? '{}');
    expect(persisted.nodes).toEqual([]);
  });

  it('falls back to a clean, persisted state when the saved pending submission is malformed', async () => {
    // Reproduction from the review: an empty object reaches session.send(undefined, ...)
    // and the rejection path then writes the literal string "undefined" into the textarea.
    const storage = storageWith(validSnapshot({ sessionId: null, pendingSubmission: {} }));
    const page = openPage(new Backend(), storage);
    await flush();
    expect(page.element('notice').textContent).toMatch(/could not be restored/i);
    expect(page.element('prompt').value).toBe('');
    const persisted = JSON.parse(storage.get('blade-web-session:v2') ?? '{}');
    expect(persisted.pendingSubmission).toBeNull();
  });

  it('falls back to a clean, persisted state when the value under the storage key belongs to something else', async () => {
    const storage = storageWith({ some: 'other app entirely', wrote: 'this key' });
    const page = openPage(new Backend(), storage);
    await flush();
    expect(page.element('notice').textContent).toMatch(/could not be restored/i);
    expect(page.messages()).toEqual([]);
    expect(page.element('session-id').textContent).toBe('Not started');
    const persisted = JSON.parse(storage.get('blade-web-session:v2') ?? '{}');
    expect(persisted.version).toBe(2);
    expect(persisted.nodes).toEqual([]);
  });
});

describe('Web Agent steering', () => {
  it('submits an instruction with priority now while a request is in flight instead of starting a new turn', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Start the task');
    // The request is already active as soon as send() resolves -- no stream
    // event is needed to reach the "agent is working" state being tested here.
    expect(page.element('submit').textContent).toBe('Steer');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.element('prompt').disabled).toBe(false);

    await page.submit('Focus on security');
    expect(backend.sendCalls.at(-1)).toMatchObject({ input: 'Focus on security', priority: 'now' });
    expect(backend.createCalls).toBe(1);
    expect(page.steerEntries()).toEqual(['Steered: Focus on security']);
    // The steer folds into the same turn: no new user bubble, no new Session.
    expect(page.messages()).toEqual([{ role: 'user', content: 'Start the task' }]);

    backend.latestStream().push(
      toolEvent(1, {
        type: 'turn_interrupted',
        inputId: 'unused',
        requestId: 'request-1',
        turn: 2,
      }),
    );
    await flush();
    expect(page.systemNotes()).toContainEqual(
      'Interrupting the current step to apply your instruction',
    );
  });

  it('renders a queued submission differently from a steered one', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Start the task');

    await page.submit('Focus on X');
    expect(page.steerEntries()).toEqual(['Steered: Focus on X']);

    backend.nextSendResult = { status: 'queued', inputId: 'input-later-1', priority: 'later' };
    await page.submit('Also check Y later');
    expect(page.steerEntries()).toEqual([
      'Steered: Focus on X',
      'Queued for next turn: Also check Y later',
    ]);
  });

  it("recovers a queued instruction's answer when it arrives under a new request id instead of dropping it", async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Start the task');

    backend.nextSendResult = { status: 'queued', inputId: 'input-queued-1', priority: 'later' };
    await page.submit('Also check this');
    expect(page.steerEntries()).toEqual(['Queued for next turn: Also check this']);
    expect(page.element('submit').disabled).toBe(false);

    // request-1 finishes; the connection must stay open for the queued turn.
    backend.latestStream().push(result(1, 'request-1'));
    await flush();
    expect(backend.sendCalls).toHaveLength(2);
    expect(page.element('status').textContent).toBe('Working');

    // The queued turn starts under a request id this page was never told
    // about ahead of time; its own input_applied is what identifies it.
    backend.latestStream().push(
      toolEvent(2, {
        type: 'input_applied',
        inputId: 'input-queued-1',
        requestId: 'request-2',
        priority: 'now',
        turn: 2,
      }),
    );
    await flush();
    expect(page.steerEntries()).toEqual(['Steering applied: Also check this']);

    // Its answer must still be read and rendered, not lost on the floor.
    backend.latestStream().push(content(3, 'request-2', 'Queued answer'), result(4, 'request-2'));
    await flush();
    expect(page.messages().at(-1)).toEqual({ role: 'assistant', content: 'Queued answer' });
    expect(page.element('status').textContent).toBe('Idle');
    expect(page.element('submit').disabled).toBe(false);
  });

  it('marks a steering entry as applied when input_applied arrives for its input id', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Start the task');
    await page.submit('Focus on security');
    expect(page.steerEntries()).toEqual(['Steered: Focus on security']);

    const steerResult = backend.sendResults.at(-1);
    backend.latestStream().push(
      toolEvent(1, {
        type: 'input_applied',
        inputId: steerResult?.inputId,
        requestId: 'request-1',
        priority: 'now',
        turn: 2,
      }),
    );
    await flush();
    expect(page.steerEntries()).toEqual(['Steering applied: Focus on security']);
  });
});

describe('Web Agent approvals and tool feedback', () => {
  it('ends tool attempts without results when the recovered request completes', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Resume the interrupted write');
    backend
      .latestStream()
      .push(
        toolEvent(1, { type: 'tool_use', id: 'old-write', name: 'RepoWrite', input: {} }),
        result(2, 'request-1'),
      );
    await flush();
    expect(page.toolCards()[0]?.textContent).toContain('RepoWrite');
    expect(page.toolCards()[0]?.textContent).toContain('Ended');
    expect(page.toolCards()[0]?.textContent).toContain('No tool result was received');
    expect(page.element('status').textContent).toBe('Idle');
  });

  it('shows current-session approvals without a request ID and approves once without replaying handled requests', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Write a report');
    backend
      .latestStream()
      .push(
        { ...permission(99, 'other-session'), sessionId: 'session-other' },
        permission(1, 'other-request', 'request-other'),
        permission(2),
        permission(3),
      );
    await flush();
    expect(page.approvalCards()).toHaveLength(1);
    expect(page.approvalCards()[0]?.textContent).toContain('Write the report?');
    expect(page.approvalCards()[0]?.textContent).toContain('WriteFile');
    expect(page.approvalCards()[0]?.textContent).toContain('report.md');
    expect(page.approvalCards()[0]?.textContent).toContain('Replaces the existing report');
    expect(page.element('status').textContent).toBe('Waiting for approval');

    await page.decide('Approve once');
    expect(backend.permissionCalls).toHaveLength(1);
    expect(backend.permissionCalls[0]).toMatchObject({
      sessionId: 'session-1',
      permissionRequestId: 'permission-1',
      response: { approved: true, scope: 'once' },
      commandId: expect.any(String),
    });
    expect(page.approvalCards()).toHaveLength(0);
    backend.latestStream().push(permission(4));
    await flush();
    expect(page.approvalCards()).toHaveLength(0);
    expect(backend.permissionCalls).toHaveLength(1);
  });

  it('approves for the whole session when the user picks that option', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Write a report');
    backend.latestStream().push(permission(1));
    await flush();
    await page.decide('Approve for this session');
    expect(backend.permissionCalls[0]).toMatchObject({
      response: { approved: true, scope: 'session' },
    });
    expect(page.approvalCards()).toHaveLength(0);
  });

  it('restores unanswered approval details after reload and lets the user deny the action', async () => {
    const backend = new Backend();
    const first = openPage(backend);
    await flush();
    await first.submit('Review the requested write');
    backend.latestStream().push(permission(1));
    await flush();
    const saved = new Map(first.storage);
    await first.unload();

    const restored = openPage(backend, saved);
    await flush();
    expect(restored.approvalCards()).toHaveLength(1);
    expect(restored.approvalCards()[0]?.textContent).toContain('Approved report');
    expect(backend.permissionCalls).toHaveLength(0);
    backend.latestStream().push(permission(2));
    await flush();
    expect(restored.approvalCards()).toHaveLength(1);
    await restored.decide('Deny');
    expect(backend.permissionCalls[0]?.response).toEqual({ approved: false, scope: 'once' });
    expect(restored.approvalCards()).toHaveLength(0);
    expect(backend.sendCalls).toHaveLength(1);
  });

  it('confirms an approval with the same command ID after its response is lost and the page is reloaded', async () => {
    const backend = new Backend();
    backend.loseNextPermissionResponse = true;
    const first = openPage(backend);
    await flush();
    await first.submit('Approve with unreliable transport');
    backend.latestStream().push(permission(1));
    await flush();
    await first.decide('Approve once');
    expect(first.element('status').textContent).toBe('Disconnected');
    expect(first.approvalCards()).toHaveLength(1);
    await first.decide('Deny');
    expect(backend.permissionCalls).toHaveLength(1);
    const saved = new Map(first.storage);
    await first.unload();

    const restored = openPage(backend, saved);
    await flush();
    expect(backend.permissionCalls).toHaveLength(2);
    expect(backend.permissionCalls[1]).toEqual(backend.permissionCalls[0]);
    expect(restored.approvalCards()).toHaveLength(0);
    backend
      .latestStream()
      .push(permission(2), content(3, 'request-1', 'Write completed'), result(4, 'request-1'));
    await flush();
    expect(restored.approvalCards()).toHaveLength(0);
    expect(restored.messages().at(-1)?.content).toBe('Write completed');
    expect(restored.element('submit').disabled).toBe(false);
  });

  it('explains expired approvals and accepts a reissued approval after worker recovery', async () => {
    const backend = new Backend();
    backend.permissionError = protocolError('PERMISSION_NOT_FOUND');
    const page = openPage(backend);
    await flush();
    await page.submit('Handle an expired approval');
    backend.latestStream().push(permission(1));
    await flush();
    await page.decide('Approve once');
    expect(page.approvalCards()).toHaveLength(0);
    expect(page.element('notice').textContent).toMatch(/approval expired or was already resolved/i);
    backend.permissionError = undefined;
    backend.latestStream().push(permission(2));
    await flush();
    expect(page.approvalCards()).toHaveLength(1);
    await page.decide('Deny');
    expect(backend.permissionCalls[1]?.commandId).not.toBe(backend.permissionCalls[0]?.commandId);
    backend
      .latestStream()
      .push(content(3, 'request-1', 'Action was skipped'), result(4, 'request-1'));
    await flush();
    expect(page.messages().at(-1)?.content).toBe('Action was skipped');
    expect(page.element('submit').disabled).toBe(false);
  });

  it('allows a new decision command after the server definitely rejects the previous one', async () => {
    const backend = new Backend();
    backend.permissionError = protocolError('INVALID_COMMAND');
    const page = openPage(backend);
    await flush();
    await page.submit('Decide after rejection');
    backend.latestStream().push(permission(1));
    await flush();
    await page.decide('Approve once');
    expect(page.approvalCards()).toHaveLength(1);
    expect(page.element('notice').textContent).toMatch(/decision was not accepted/i);
    backend.permissionError = undefined;
    await page.decide('Deny');
    expect(backend.permissionCalls).toHaveLength(2);
    expect(backend.permissionCalls[1]?.commandId).not.toBe(backend.permissionCalls[0]?.commandId);
    expect(backend.permissionCalls[1]?.response.approved).toBe(false);
    expect(page.approvalCards()).toHaveLength(0);
  });

  it.each([
    'complete',
    'cancel',
  ] as const)('clears approvals when the request ends by %s and ignores them in later requests', async (ending) => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('First task');
    backend.latestStream().push(permission(1));
    await flush();
    if (ending === 'cancel') {
      let acknowledgeAbort!: () => void;
      backend.abortGate = new Promise<void>((resolve) => {
        acknowledgeAbort = resolve;
      });
      await page.click('cancel');
      expect(page.approvalCards()).toHaveLength(1);
      await page.decide('Approve once');
      expect(backend.permissionCalls).toHaveLength(0);
      acknowledgeAbort();
    } else {
      backend.latestStream().push(result(2, 'request-1'));
    }
    await flush();
    expect(page.approvalCards()).toHaveLength(0);

    await page.submit('Second task');
    backend.latestStream().push(permission(3), permission(4, 'permission-new', 'request-2'));
    await flush();
    expect(page.approvalCards()).toHaveLength(1);
    await page.decide('Deny');
    expect(backend.permissionCalls.at(-1)?.permissionRequestId).toBe('permission-new');
  });

  it('does not reopen an ended request when an in-flight approval is acknowledged late', async () => {
    const backend = new Backend();
    let acknowledgePermission!: () => void;
    backend.permissionGate = new Promise<void>((resolve) => {
      acknowledgePermission = resolve;
    });
    const page = openPage(backend);
    await flush();
    await page.submit('Finish before approval response');
    backend.latestStream().push(permission(1));
    await flush();
    await page.decide('Approve once');
    backend.latestStream().push(result(2, 'request-1'));
    await flush();
    expect(page.approvalCards()).toHaveLength(0);
    acknowledgePermission();
    await flush();
    expect(page.element('status').textContent).toBe('Idle');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.approvalCards()).toHaveLength(0);
  });

  it('shows a proposed file change as Before and After when the tool input carries expected_content', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Fix the greeting script');
    backend.latestStream().push(
      permission(1, 'permission-1', undefined, {
        path: 'src/greeting.sh',
        expected_content: 'echo Hello, World!',
        content: 'echo Hello, Blade!',
      }),
    );
    await flush();
    const card = page.approvalCards()[0];
    expect(card?.textContent).toContain('Proposed file change');
    expect(card?.textContent).toContain('Before');
    expect(card?.textContent).toContain('echo Hello, World!');
    expect(card?.textContent).toContain('After');
    expect(card?.textContent).toContain('echo Hello, Blade!');
    // This is the exact rendering examples/production-stack/run.mjs relies on
    // from the same shared client.js/index.html -- it must open by default.
    expect(page.approvalDetailsOpen(0)).toBe(true);
  });

  it('shows tool progress and result summaries while keeping runtime metadata out of the page', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Run a tool');
    backend.latestStream().push(
      toolEvent(1, {
        type: 'tool_use',
        id: 'tool-1',
        name: 'WriteFile',
        input: { path: 'report.md' },
      }),
      toolEvent(2, {
        type: 'tool_progress',
        id: 'tool-1',
        name: 'WriteFile',
        progress: {
          kind: 'progress',
          message: 'Writing report',
          completed: 1,
          total: 2,
          resumeToken: 'private-resume-token',
          data: { lease: 'private-lease' },
        },
      }),
    );
    await flush();
    expect(page.toolCards()).toHaveLength(1);
    expect(page.toolCards()[0]?.textContent).toContain('WriteFile');
    expect(page.toolCards()[0]?.textContent).toContain('Writing report · 1/2');
    expect(page.element('timeline').textContent).not.toMatch(/private-resume-token|private-lease/);

    backend.latestStream().push(
      toolEvent(3, {
        type: 'tool_result',
        id: 'tool-1',
        name: 'WriteFile',
        output: 'Saved 42 bytes',
        display: { summary: 'Saved report.md', detail: { internal: 'private-detail-marker' } },
      }),
      toolEvent(4, { type: 'tool_use', id: 'tool-2', name: 'ListFiles', input: {} }),
      toolEvent(5, {
        type: 'tool_result',
        id: 'tool-2',
        name: 'ListFiles',
        output: { files: ['report.md'] },
      }),
      result(6, 'request-1'),
    );
    await flush();
    expect(page.toolCards()[0]?.textContent).toContain('Completed');
    expect(page.toolCards()[0]?.textContent).toContain('Saved report.md');
    // Unlike the old console UI, the timeline intentionally shows each tool's real
    // output next to its curated summary -- that is the point of task 7's "one
    // card per tool call ... with output" -- so this is expected, not a leak.
    expect(page.toolCards()[0]?.textContent).toContain('Saved 42 bytes');
    expect(page.toolCards()[1]?.textContent).toContain('ListFiles');
    expect(page.toolCards()[1]?.textContent).toContain('"report.md"');
    // display.detail is the one field neither client ever reads, so it alone must stay out of the page.
    expect(page.element('timeline').textContent).not.toMatch(/private-detail-marker/);
  });

  it('moves a tool card from running to failed and shows its output', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Run the test suite');
    backend.latestStream().push(
      toolEvent(1, {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'npm test' },
      }),
    );
    await flush();
    expect(page.toolCards()[0]?.dataset.status).toBe('Running');

    backend.latestStream().push(
      toolEvent(2, {
        type: 'tool_result',
        id: 'tool-1',
        name: 'Bash',
        isError: true,
        output: 'exit 1',
        display: { summary: 'npm test failed' },
      }),
    );
    await flush();
    expect(page.toolCards()[0]?.dataset.status).toBe('Failed');
    expect(page.toolCards()[0]?.textContent).toContain('npm test failed');
    expect(page.toolCards()[0]?.textContent).toContain('exit 1');
  });

  it('renders thinking deltas in a collapsed block', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Explain your plan');
    backend
      .latestStream()
      .push(
        toolEvent(1, { type: 'thinking', delta: 'First, check ' }),
        toolEvent(2, { type: 'thinking', delta: 'the manifest.' }),
      );
    await flush();
    expect(page.thinkingBlocks()).toHaveLength(1);
    expect(page.thinkingBlocks()[0]?.open).toBe(false);
    expect(page.thinkingBlocks()[0]?.textContent).toContain('First, check the manifest.');

    backend.latestStream().push(content(3, 'request-1', 'Plan ready.'), result(4, 'request-1'));
    await flush();
    expect(page.messages()).toEqual([
      { role: 'user', content: 'Explain your plan' },
      { role: 'assistant', content: 'Plan ready.' },
    ]);
    expect(page.thinkingBlocks()).toHaveLength(1);
  });

  it('exposes only the truncated, JSON-serialized tool input in the card header', async () => {
    // The card header shows a tool's real arguments unredacted -- that is
    // deliberate (task 7: seeing the actual command is what makes the card
    // evidence the agent is really working), but it must stay bounded to
    // summarizeArgs()'s own 160-character cap, not dump an arbitrarily large
    // input onto the page.
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Run a tool with a large input');
    const large = 'x'.repeat(500);
    backend.latestStream().push(
      toolEvent(1, {
        type: 'tool_use',
        id: 'tool-1',
        name: 'WriteFile',
        input: { path: 'report.md', body: large },
      }),
    );
    await flush();
    const serialized = JSON.stringify({ path: 'report.md', body: large });
    const expectedArgs = `${serialized.slice(0, 157)}…`;
    expect(page.toolCards()[0]?.textContent).toContain(expectedArgs);
    expect(page.toolCards()[0]?.textContent).not.toContain(large);
  });

  it('reuses the same element across renders instead of recreating it', async () => {
    // The scroll-position and focus problems the review raised both trace back
    // to recreating every element on every render; this pins the fix directly,
    // rather than only its user-visible symptoms.
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Long streaming answer');
    backend.latestStream().push(content(1, 'request-1', 'Part one. '));
    await flush();
    const assistantElement = page.element('timeline').children.at(-1);
    backend.latestStream().push(content(2, 'request-1', 'Part two.'));
    await flush();
    expect(page.element('timeline').children.at(-1)).toBe(assistantElement);
    expect(assistantElement?.textContent).toBe('Part one. Part two.');
  });

  it('announces coarse status changes instead of the full streamed text', async () => {
    // #timeline is no longer aria-live (a screen reader used to re-announce
    // the whole conversation on every token); this small #announcer element
    // is, and it must describe what changed, not repeat the growing answer.
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Explain this');
    backend.latestStream().push(content(1, 'request-1', 'Hello'));
    await flush();
    expect(page.announced()).toBe('The agent is answering.');
    backend.latestStream().push(content(2, 'request-1', ' world'));
    await flush();
    // Still the same answer streaming in: nothing new to announce.
    expect(page.announced()).toBe('The agent is answering.');
    backend
      .latestStream()
      .push(toolEvent(3, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }));
    await flush();
    expect(page.announced()).toBe('Bash running.');
  });
});
