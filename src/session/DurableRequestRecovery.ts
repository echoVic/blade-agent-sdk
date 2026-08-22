import type { UserMessageContent } from '../agent/types.js';
import type { ContentPart } from '../services/ChatServiceInterface.js';
import type { RuntimeContext } from '../runtime/index.js';
import type { JsonObject, JsonValue } from '../types/common.js';
import { toJsonValue } from '../utils/jsonValue.js';
import { SessionDurableRecorderError } from './events/SessionDurableRecorder.js';

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeDurableRuntimeContext(context: RuntimeContext): JsonObject {
  const serialized = toJsonValue(context);
  if (typeof serialized !== 'object' || serialized === null || Array.isArray(serialized)) {
    throw new SessionDurableRecorderError('Request runtime context is not a JSON object');
  }
  return serialized;
}

export function parseDurableUserMessageContent(input: JsonValue): UserMessageContent {
  if (typeof input === 'string') {
    return input;
  }
  if (!Array.isArray(input)) {
    throw new SessionDurableRecorderError(
      'A recoverable request input must be text or an array of content parts',
    );
  }

  return input.map((value, index): ContentPart => {
    if (!isJsonObject(value)) {
      throw new SessionDurableRecorderError(
        `Recoverable request content part ${index} is not an object`,
      );
    }
    if (value.type === 'text' && typeof value.text === 'string') {
      if (value.providerOptions !== undefined && !isJsonObject(value.providerOptions)) {
        throw new SessionDurableRecorderError(
          `Recoverable request text part ${index} has invalid providerOptions`,
        );
      }
      return {
        type: 'text',
        text: value.text,
        ...(value.providerOptions
          ? {
              providerOptions: structuredClone(value.providerOptions) as Extract<
                ContentPart,
                { type: 'text' }
              >['providerOptions'],
            }
          : {}),
      };
    }
    if (
      value.type === 'image_url' &&
      isJsonObject(value.image_url) &&
      typeof value.image_url.url === 'string'
    ) {
      return {
        type: 'image_url',
        image_url: {
          url: value.image_url.url,
        },
      };
    }
    throw new SessionDurableRecorderError(`Recoverable request content part ${index} is invalid`);
  });
}

export function parseDurableRuntimeContext(
  context: JsonObject | undefined,
): RuntimeContext | undefined {
  if (!context) {
    return undefined;
  }
  if (context.id !== undefined && typeof context.id !== 'string') {
    throw new SessionDurableRecorderError('Recoverable request context.id must be a string');
  }
  if (
    context.environment !== undefined &&
    (!isJsonObject(context.environment) ||
      Object.values(context.environment).some((value) => typeof value !== 'string'))
  ) {
    throw new SessionDurableRecorderError(
      'Recoverable request context.environment must contain string values',
    );
  }
  if (context.metadata !== undefined && !isJsonObject(context.metadata)) {
    throw new SessionDurableRecorderError('Recoverable request context.metadata must be an object');
  }

  const capabilities = context.capabilities;
  if (capabilities !== undefined && !isJsonObject(capabilities)) {
    throw new SessionDurableRecorderError(
      'Recoverable request context.capabilities must be an object',
    );
  }
  if (isJsonObject(capabilities)) {
    const filesystem = capabilities.filesystem;
    if (
      filesystem !== undefined &&
      (!isJsonObject(filesystem) ||
        !Array.isArray(filesystem.roots) ||
        filesystem.roots.some((root) => typeof root !== 'string') ||
        (filesystem.cwd !== undefined && typeof filesystem.cwd !== 'string'))
    ) {
      throw new SessionDurableRecorderError('Recoverable request filesystem capability is invalid');
    }
    const browser = capabilities.browser;
    if (
      browser !== undefined &&
      (!isJsonObject(browser) ||
        (browser.pageId !== undefined && typeof browser.pageId !== 'string') ||
        (browser.tabId !== undefined && typeof browser.tabId !== 'string'))
    ) {
      throw new SessionDurableRecorderError('Recoverable request browser capability is invalid');
    }
    const network = capabilities.network;
    if (
      network !== undefined &&
      (!isJsonObject(network) ||
        (network.allowDomains !== undefined &&
          (!Array.isArray(network.allowDomains) ||
            network.allowDomains.some((domain) => typeof domain !== 'string'))))
    ) {
      throw new SessionDurableRecorderError('Recoverable request network capability is invalid');
    }
  }

  return structuredClone(context) as RuntimeContext;
}
