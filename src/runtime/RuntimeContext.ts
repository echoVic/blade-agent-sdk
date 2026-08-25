import type { JsonObject } from '../types/json.js';

export interface RuntimeContext {
  id?: string;
  capabilities?: {
    filesystem?: {
      roots: string[];
      cwd?: string;
    };
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
