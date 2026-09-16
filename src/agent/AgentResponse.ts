import type { InputSubmission, SessionStreamEvent } from '../session/types.js';

export type AgentResponseSubmission = Extract<InputSubmission, { status: 'started' }>;

export type AgentResponseEventType = SessionStreamEvent['type'];

export type AgentResponseEvent<TType extends AgentResponseEventType> = Extract<
  SessionStreamEvent,
  { type: TType }
>;

export type AgentResponseListener<TType extends AgentResponseEventType> = (
  event: AgentResponseEvent<TType>,
) => void | Promise<void>;

type AnyAgentResponseListener = (event: SessionStreamEvent) => void | Promise<void>;

export class AgentResponse {
  private readonly events: SessionStreamEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Map<AgentResponseEventType, Set<AnyAgentResponseListener>>();
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
      for await (const chunk of this.textStream()) {
        text += chunk;
      }
      return text;
    })();
    return this.textPromise;
  }

  async *textStream(): AsyncGenerator<string> {
    let emittedContent = false;
    for await (const event of this.stream()) {
      if (event.type === 'content') {
        emittedContent = true;
        yield event.delta;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      } else if (event.type === 'result' && event.subtype === 'error') {
        throw new Error(event.error ?? 'Agent response failed');
      } else if (
        event.type === 'result' &&
        event.subtype === 'success' &&
        !emittedContent &&
        event.content
      ) {
        emittedContent = true;
        yield event.content;
      }
    }
  }

  stream(): AsyncGenerator<SessionStreamEvent> {
    return this.iterateEvents();
  }

  on<TType extends AgentResponseEventType>(
    type: TType,
    listener: AgentResponseListener<TType>,
  ): this {
    const listeners = this.listeners.get(type) ?? new Set<AnyAgentResponseListener>();
    listeners.add(listener as unknown as AnyAgentResponseListener);
    this.listeners.set(type, listeners);
    this.start();
    return this;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  private start(): void {
    if (this.completion) {
      return;
    }
    this.completion = this.consume();
    void this.completion.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.events.push(event);
        const listeners = this.listeners.get(event.type);
        if (listeners) {
          for (const listener of listeners) {
            await listener(event);
          }
        }
        this.wakeConsumers();
      }
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.settled = true;
      this.wakeConsumers();
      this.onSettled?.();
    }
  }

  private async *iterateEvents(): AsyncGenerator<SessionStreamEvent> {
    this.start();
    let index = 0;

    while (true) {
      while (index < this.events.length) {
        const event = this.events[index];
        index += 1;
        if (event) {
          yield event;
        }
      }
      if (this.failure !== undefined) {
        throw this.failure;
      }
      if (this.settled) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }

  private wakeConsumers(): void {
    if (this.waiters.size === 0) {
      return;
    }
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}
