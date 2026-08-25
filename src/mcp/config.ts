export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  alwaysAllow?: string[];
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    provider: string;
    clientId?: string;
    enabled?: boolean;
  };
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}
