export type QuerySource =
  | 'main_thread'
  | 'agent'
  | 'compact'
  | 'side_question'
  | 'hook_agent'
  | 'hook_prompt'
  | 'verification_agent'
  | 'summary'
  | 'suggestion'
  | 'classifier';

export interface ModelRetryEvent {
  type: 'retry_attempt';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: {
    status?: number;
    message: string;
  };
  querySource?: QuerySource;
}

export interface ModelRetryConfig {
  /** Maximum number of retries after the initial attempt. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
  max529Retries: number;
  fallbackModel?: string;
  currentModel?: string;
  querySource?: QuerySource;
  onRetry?: (event: ModelRetryEvent) => void | Promise<void>;
}
