import type { InputSubmission, SessionStreamEvent } from '../session/types.js';

export type AgentResponseSubmission = Extract<InputSubmission, { status: 'started' }>;
export type AgentResponseEventType = SessionStreamEvent['type'];
export type AgentResponseEvent<T extends AgentResponseEventType> = Extract<
  SessionStreamEvent,
  { type: T }
>;
export type AgentResponseListener<T extends AgentResponseEventType> = (
  event: AgentResponseEvent<T>,
) => void | Promise<void>;
type Listener = (event: SessionStreamEvent) => void | Promise<void>;

export class AgentResponse {
  private readonly events: SessionStreamEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Map<AgentResponseEventType, Set<Listener>>();
  private completion?: Promise<void>;
  private textPromise?: Promise<string>;
  private failure?: unknown;
  private settled = false;

  constructor(
    readonly submission: AgentResponseSubmission,
    private readonly source: AsyncIterable<SessionStreamEvent>,
    private readonly onSettled?: () => void,
  ) {}

  text(): Promise<string> {
    this.textPromise ??= (async () => {
      let text = '';
      for await (const chunk of this.textStream()) text += chunk;
      return text;
    })();
    return this.textPromise;
  }

  async *textStream(): AsyncGenerator<string> {
    let emitted = false;
    for await (const event of this.stream()) {
      if (event.type === 'content') {
        emitted = true;
        yield event.delta;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      } else if (event.type === 'result' && event.subtype === 'error') {
        throw new Error(event.error ?? 'Agent response failed');
      } else if (event.type === 'result' && !emitted && event.content) {
        emitted = true;
        yield event.content;
      }
    }
  }

  stream(): AsyncGenerator<SessionStreamEvent> {
    return this.iterate();
  }

  on<T extends AgentResponseEventType>(type: T, listener: AgentResponseListener<T>): this {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(type, listeners);
    this.start();
    return this;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  private start(): void {
    if (this.completion) return;
    this.completion = this.consume();
    void this.completion.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.events.push(event);
        for (const listener of this.listeners.get(event.type) ?? []) await listener(event);
        this.wake();
      }
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.settled = true;
      this.wake();
      this.onSettled?.();
    }
  }

  private async *iterate(): AsyncGenerator<SessionStreamEvent> {
    this.start();
    let index = 0;
    while (true) {
      while (index < this.events.length) yield this.events[index++] as SessionStreamEvent;
      if (this.failure !== undefined) throw this.failure;
      if (this.settled) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}
