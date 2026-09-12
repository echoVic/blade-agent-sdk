import type { SandboxSettings } from '../sandbox/config.js';
import type { JsonObject } from '../types/json.js';

export interface RuntimeContext {
  id?: string;
  capabilities?: {
    filesystem?: {
      roots: string[];
      cwd?: string;
    };
    /**
     * Sandbox policy for this context. It belongs here rather than in a process
     * singleton so two Sessions with different policies cannot affect each other.
     */
    sandbox?: SandboxSettings;
    browser?: {
      pageId?: string;
      tabId?: string;
    };
    network?: {
      allowDomains?: string[];
    };
  };
  environment?: Record<string, string>;
  metadata?: JsonObject;
}
