import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';
import type { WebSearchResult } from './searchProviders.js';

interface CacheEntry {
  query: string;
  provider: string;
  results: WebSearchResult[];
  timestamp: number;
  expiresAt: number;
}

export interface CacheConfig {
  maxSize: number;
  ttl: number;
  enabled: boolean;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  enabled: boolean;
  ttl: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class SearchCache {
  private cache: LRUCache<string, CacheEntry>;
  private config: CacheConfig;
  private hits = 0;
  private misses = 0;

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxSize: config?.maxSize ?? 100,
      ttl: config?.ttl ?? 3600 * 1000,
      enabled: config?.enabled ?? true,
    };

    this.cache = new LRUCache<string, CacheEntry>({
      max: this.config.maxSize,
      ttl: this.config.ttl,
      updateAgeOnGet: true,
      updateAgeOnHas: false,
    });
  }

  private generateKey(provider: string, query: string): string {
    const normalized = query.toLowerCase().trim();
    const hash = crypto
      .createHash('md5')
      .update(normalized)
      .digest('hex')
      .substring(0, 8);
    return `${provider}:${hash}`;
  }

  get(provider: string, query: string): WebSearchResult[] | null {
    if (!this.config.enabled) return null;

    const key = this.generateKey(provider, query);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.results;
  }

  set(provider: string, query: string, results: WebSearchResult[]): void {
    if (!this.config.enabled || results.length === 0) return;

    const key = this.generateKey(provider, query);
    const now = Date.now();

    this.cache.set(key, {
      query,
      provider,
      results,
      timestamp: now,
      expiresAt: now + this.config.ttl,
    });
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? (this.hits / total) * 100 : 0;
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      enabled: this.config.enabled,
      ttl: this.config.ttl,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number.parseFloat(hitRate.toFixed(2)),
    };
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  enable(): void { this.config.enabled = true; }
  disable(): void { this.config.enabled = false; }
  isEnabled(): boolean { return this.config.enabled; }

  updateConfig(config: Partial<CacheConfig>): void {
    if (config.maxSize !== undefined && config.maxSize !== this.config.maxSize) {
      this.config.maxSize = config.maxSize;
      const oldEntries = Array.from(this.cache.entries());
      this.cache = new LRUCache<string, CacheEntry>({
        max: this.config.maxSize,
        ttl: this.config.ttl,
        updateAgeOnGet: true,
        updateAgeOnHas: false,
      });
      for (const [key, value] of oldEntries.slice(-this.config.maxSize)) {
        this.cache.set(key, value);
      }
    }
    if (config.ttl !== undefined) this.config.ttl = config.ttl;
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
  }
}

const globalSearchCache = new SearchCache();

export function getSearchCache(): SearchCache {
  return globalSearchCache;
}
