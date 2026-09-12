import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AgentProtocolError, parseAgentEventCursor } from '../../src/protocol/index.js';

type Listener = (event: { preventDefault(): void; persisted?: boolean }) => unknown;

// Exercise the shipped page script without a browser dependency. The DOM double
// deliberately models only the elements and events used by this small example.
class Element {
  children: Element[] = [];
  className = '';
  disabled = false;
  hidden = false;
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
    this.children = [];
  }

  append(...children: Element[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]): void {
    this.text = '';
    this.children = children;
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
          await new Promise<void>((resolve) => { this.wake = resolve; });
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

class Backend {
  createCalls = 0;
  createCommandIds: (string | undefined)[] = [];
  resumeCalls: string[] = [];
  sendCalls: { sessionId: string; input: string; commandId?: string }[] = [];
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
      send: async (input: string, options: { commandId?: string } = {}) => {
        this.sendCalls.push({ sessionId, input, ...options });
        if (this.sendError) throw this.sendError;
        const key = options.commandId ?? `submission-${this.sendCalls.length}`;
        let requestId = this.requests.get(key);
        if (!requestId) {
          requestId = `request-${this.requests.size + 1}`;
          this.requests.set(key, requestId);
        }
        if (this.loseNextSendResponse) {
          this.loseNextSendResponse = false;
          throw new TypeError('Failed to fetch after the server accepted the input');
        }
        return { sessionId, inputId: `input-${requestId}`, requestId, status: 'started' };
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
      close: async () => { this.closeCalls.push(sessionId); },
      read: async () => ({ session: { sessionId, status: this.sessionStatus }, messages: [], pendingInputs: [] }),
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
        backend.permissionCalls.push({ sessionId, permissionRequestId, response, commandId: options.commandId });
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

function permission(sequence: number, id = 'permission-1', requestId?: string): EventData {
  return {
    ...content(sequence, 'request-1', ''),
    requestId,
    type: 'permission.requested',
    data: {
      permissionRequestId: id,
      toolName: 'WriteFile',
      input: { path: 'report.md', content: 'Approved report' },
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

function protocolError(
  code: 'SESSION_NOT_FOUND' | 'STALE_CURSOR' | 'SESSION_CONFLICT' | 'INVALID_COMMAND' | 'PERMISSION_NOT_FOUND',
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
    'prompt-form', 'prompt', 'transcript', 'status', 'session-id',
    'submit', 'cancel', 'reconnect', 'new-session', 'notice',
  ]) elements.set(id, new Element());
  const element = (id: string): Element => {
    const found = elements.get(id);
    if (!found) throw new Error(`Unknown element: ${id}`);
    return found;
  };
  const descendants = (parent: Element): Element[] => parent.children.flatMap((child) => [child, ...descendants(child)]);
  const approvalCards = () => element('transcript').children.filter((child) => child.className === 'approval-card');
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const windowEvents = new Element();
  const window = {
    location: { origin: 'http://localhost:8787' },
    sessionStorage,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
  };
  const source = readFileSync(resolve('examples/web-agent-server/client.js'), 'utf8')
    .replace(/^import\s+\{\s*AgentClient\s*\}\s+from\s+['"][^'"]+['"];?\s*/m, '');
  runInNewContext(source, {
    AgentClient: backend.clientClass(),
    document: {
      querySelector: (selector: string) => elements.get(selector.slice(1)) ?? null,
      createElement: (tag: string) => new Element(tag),
    },
    window,
    navigator: { onLine: true },
    sessionStorage,
    crypto: webcrypto,
    Error,
    TypeError,
    AbortController,
    AbortSignal,
    DOMException,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: 'web-agent-client.js' });

  return {
    storage,
    element,
    approvalCards,
    toolCards: () => element('transcript').children.filter((child) => child.className === 'tool-card'),
    messages: () => element('transcript').children
      .filter((article) => article.className.includes('message-'))
      .map((article) => ({
        role: article.children[0]?.textContent,
        content: article.children[1]?.textContent,
      })),
    async submit(input: string) {
      element('prompt').value = input;
      element('prompt-form').dispatch('submit');
      await flush();
    },
    async click(id: string) {
      element(id).dispatch('click');
      await flush();
    },
    async decide(label: 'Approve once' | 'Deny', index = 0) {
      const card = approvalCards()[index];
      const button = card && descendants(card).find((child) => child.tagName === 'button' && child.textContent === label);
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
    backend.latestStream().push(
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
    backend.abortGate = new Promise<void>((resolve) => { acknowledgeAbort = resolve; });
    await page.click('cancel');
    expect(backend.abortCalls).toEqual(['session-1']);
    expect(page.element('status').textContent).toMatch(/cancelling/i);
    expect(page.element('submit').disabled).toBe(true);
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
    expect(page.element('status').textContent).toBe('Running');
    expect(page.element('cancel').disabled).toBe(false);
    expect(page.element('submit').disabled).toBe(true);
    expect(backend.eventCalls.at(-1)?.options.after).toEqual(cursor(1));

    await page.click('cancel');
    expect(backend.abortCommandIds).toHaveLength(2);
    expect(backend.abortCommandIds[0]).toEqual(expect.any(String));
    expect(backend.abortCommandIds[1]).not.toBe(backend.abortCommandIds[0]);
    backend.latestStream().push(content(2, 'request-1', 'working'), result(3, 'request-1'));
    await flush();

    expect(page.messages().at(-1)?.content).toBe('Still working');
    expect(page.element('status').textContent).toBe('Ready');
    expect(page.element('submit').disabled).toBe(false);
    expect(backend.sendCalls).toHaveLength(1);
  });

  it('settles a result received while cancellation is awaiting a definite rejection', async () => {
    const backend = new Backend();
    backend.abortError = protocolError('SESSION_CONFLICT', true);
    let releaseAbort!: () => void;
    backend.abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const page = openPage(backend);
    await flush();
    await page.submit('Almost done');
    backend.latestStream().push(content(1, 'request-1', 'Completed answer'));
    await flush();
    await page.click('cancel');
    backend.latestStream().push(result(2, 'request-1'));
    await flush();
    expect(page.element('status').textContent).toBe('Cancelling');
    expect(page.element('submit').disabled).toBe(true);

    releaseAbort();
    await flush();
    expect(page.element('status').textContent).toBe('Ready');
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
    backend.latestStream().push(content(2, 'request-1', 'After returning.'), result(3, 'request-1'));
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
    expect(reloaded.element('status').textContent).toBe('Session unavailable');
    expect(reloaded.messages().at(-1)?.content).toBe('Saved answer');
    expect(reloaded.element('new-session').disabled).toBe(false);
    expect(reloaded.element('reconnect').hidden).toBe(true);
    await reloaded.click('new-session');
    await reloaded.submit('New task');
    expect(backend.sendCalls.at(-1)).toMatchObject({ sessionId: 'session-2', input: 'New task' });
  });

  it.each(['SESSION_NOT_FOUND', 'STALE_CURSOR'] as const)(
    'preserves readable history and offers a new Session when recovery returns %s',
    async (code) => {
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
      expect(reloaded.element('status').textContent).not.toBe('Ready');
      backend.resumeError = undefined;
      await reloaded.click('new-session');
      await reloaded.submit('Start again');
      expect(backend.sendCalls.at(-1)).toMatchObject({ sessionId: 'session-2', input: 'Start again' });
    },
  );
});

describe('Web Agent approvals and tool feedback', () => {
  it('ends tool attempts without results when the recovered request completes', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Resume the interrupted write');
    backend.latestStream().push(
      toolEvent(1, { type: 'tool_use', id: 'old-write', name: 'RepoWrite', input: {} }),
      result(2, 'request-1'),
    );
    await flush();
    expect(page.toolCards()[0]?.textContent).toContain('RepoWrite · Ended');
    expect(page.toolCards()[0]?.textContent).toContain('No tool result was received');
    expect(page.element('status').textContent).toBe('Ready');
  });

  it('shows current-session approvals without a request ID and approves once without replaying handled requests', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Write a report');
    backend.latestStream().push(
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
    backend.latestStream().push(permission(2), content(3, 'request-1', 'Write completed'), result(4, 'request-1'));
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
    backend.latestStream().push(content(3, 'request-1', 'Action was skipped'), result(4, 'request-1'));
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

  it.each(['complete', 'cancel'] as const)('clears approvals when the request ends by %s and ignores them in later requests', async (ending) => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('First task');
    backend.latestStream().push(permission(1));
    await flush();
    if (ending === 'cancel') {
      let acknowledgeAbort!: () => void;
      backend.abortGate = new Promise<void>((resolve) => { acknowledgeAbort = resolve; });
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
    backend.permissionGate = new Promise<void>((resolve) => { acknowledgePermission = resolve; });
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
    expect(page.element('status').textContent).toBe('Ready');
    expect(page.element('submit').disabled).toBe(false);
    expect(page.approvalCards()).toHaveLength(0);
  });

  it('shows tool progress and result summaries while keeping runtime metadata out of the page', async () => {
    const backend = new Backend();
    const page = openPage(backend);
    await flush();
    await page.submit('Run a tool');
    backend.latestStream().push(
      toolEvent(1, { type: 'tool_use', id: 'tool-1', name: 'WriteFile', input: { internalMarker: 'private-input-marker' } }),
      toolEvent(2, {
        type: 'tool_progress', id: 'tool-1', name: 'WriteFile',
        progress: { kind: 'progress', message: 'Writing report', completed: 1, total: 2, resumeToken: 'private-resume-token', data: { lease: 'private-lease' } },
      }),
    );
    await flush();
    expect(page.toolCards()).toHaveLength(1);
    expect(page.toolCards()[0]?.textContent).toContain('WriteFile');
    expect(page.toolCards()[0]?.textContent).toContain('Writing report · 1/2');
    expect(page.element('transcript').textContent).not.toMatch(/private-input-marker|private-resume-token|private-lease/);

    backend.latestStream().push(toolEvent(3, {
      type: 'tool_result', id: 'tool-1', name: 'WriteFile',
      output: { internalMarker: 'private-result-marker' }, display: { summary: 'Saved report.md', detail: { internal: 'private-detail-marker' } },
    }), toolEvent(4, {
      type: 'tool_result', id: 'tool-2', name: 'ListFiles', output: { files: ['report.md'] },
    }), result(5, 'request-1'));
    await flush();
    expect(page.toolCards()[0]?.textContent).toContain('Completed');
    expect(page.toolCards()[0]?.textContent).toContain('Saved report.md');
    expect(page.toolCards()[1]?.textContent).toContain('ListFiles');
    expect(page.toolCards()[1]?.textContent).toContain('{"files":["report.md"]}');
    expect(page.element('transcript').textContent).not.toMatch(/private-result-marker|private-detail-marker/);
  });
});
