import { AgentProtocolError, type AgentProtocolErrorCode } from '../protocol/index.js';
import { SessionId } from '../types/identifiers.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/;

export function validPrincipalSubject(subject: string): boolean {
  return (
    subject.length >= 1 &&
    subject.length <= 256 &&
    subject === subject.trim() &&
    Array.from(subject).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
  );
}

export function parseRouteSessionId(encoded: string): SessionId {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (cause) {
    throw new AgentProtocolError(
      'INVALID_COMMAND',
      'Session identifier is not valid URL encoding',
      400,
      false,
      undefined,
      undefined,
      { cause },
    );
  }
  if (!SESSION_ID_PATTERN.test(decoded)) {
    throw new AgentProtocolError('INVALID_COMMAND', 'Session identifier is invalid', 400);
  }
  return SessionId(decoded);
}

export function protocolStatus(code: AgentProtocolErrorCode): number {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'SESSION_NOT_FOUND' || code === 'PERMISSION_NOT_FOUND') return 404;
  if (
    [
      'SESSION_CONFLICT',
      'COMMAND_CONFLICT',
      'COMMAND_IN_PROGRESS',
      'COMMAND_ABANDONED',
      'STALE_CURSOR',
    ].includes(code)
  ) {
    return 409;
  }
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'OVERLOADED') return 503;
  if (code === 'PROTOCOL_VERSION_UNSUPPORTED' || code === 'INVALID_COMMAND') return 400;
  return 500;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
