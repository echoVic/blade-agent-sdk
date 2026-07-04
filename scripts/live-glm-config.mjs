import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY_ALIASES = [
  'GLM_API_KEY',
  'INTEGRATION_API_KEY',
  'OPENAI_API_KEY',
  'API_KEY',
  'apikey',
  'apiKey',
  'key',
];

const BASE_URL_ALIASES = [
  'GLM_BASE_URL',
  'INTEGRATION_BASE_URL',
  'OPENAI_BASE_URL',
  'BASE_URL',
  'baseurl',
  'baseUrl',
  'url',
];

const MODEL_ALIASES = [
  'GLM_MODEL',
  'INTEGRATION_MODEL',
  'MODEL',
  'model',
];

export function loadLiveGlmConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fileEnv = readEnvFile(join(cwd, '.env'));
  const merged = {
    ...fileEnv,
    ...definedEntries(env),
  };

  const apiKey = pickFirst(merged, API_KEY_ALIASES);
  const baseUrl = pickFirstBaseUrl(merged, BASE_URL_ALIASES);
  const model = pickFirst(merged, MODEL_ALIASES) ?? 'glm-5.2';

  if (!apiKey || !baseUrl) {
    return {
      skipReason: 'Missing GLM live test credentials. Set GLM_API_KEY/GLM_BASE_URL or provide key/url in .env.',
    };
  }

  return {
    apiKey,
    baseUrl,
    model,
  };
}

function normalizeOpenAICompatibleBaseUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return {};

  const parsedJson = tryParseJson(text);
  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
    return flattenJsonEnv(parsedJson);
  }

  return parseKeyValueEnv(text);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function flattenJsonEnv(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;

  for (const [key, nestedValue] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      flattenJsonEnv(nestedValue, path, result);
      continue;
    }
    if (typeof nestedValue === 'string' || typeof nestedValue === 'number' || typeof nestedValue === 'boolean') {
      result[key] = String(nestedValue);
      result[path] = String(nestedValue);
    }
  }
  return result;
}

function parseKeyValueEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = unquote(rawValue);
  }
  return result;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function definedEntries(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
}

function pickFirst(env, aliases) {
  for (const alias of aliases) {
    const value = env[alias];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickFirstBaseUrl(env, aliases) {
  for (const alias of aliases) {
    const value = env[alias];
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = normalizeOpenAICompatibleBaseUrl(value);
    if (normalized) return normalized;
  }
  return undefined;
}
