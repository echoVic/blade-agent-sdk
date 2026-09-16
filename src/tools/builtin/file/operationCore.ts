import { extname } from 'node:path';
import type { MessageId, SessionId } from '../../../types/identifiers.js';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import type { ExecutionContext } from '../../types/execution.js';
import { ToolErrorType, type ToolResult, type ToolValidationError } from '../../types/result.js';
import { resolveAuthorizedFilesystemPath } from '../../validation/filesystemPath.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';

type PathParams<K extends string> = Record<K, string>;
type WriteOperation = 'edit' | 'write';

export async function validateFilePath<K extends string>(
  params: PathParams<K>,
  key: K,
  context: ExecutionContext,
  allowMissing = false,
): Promise<ToolValidationError | undefined> {
  try {
    params[key] = await resolveAuthorizedFilesystemPath(params[key], context.contextSnapshot, {
      allowMissing,
    });
    return undefined;
  } catch (error) {
    const message = getErrorMessage(error);
    return { message, model: message, errorType: ToolErrorType.PERMISSION_DENIED };
  }
}

export function filePermission(filePath: string): {
  signatureContent: string;
  abstractRule: string;
} {
  const extension = extname(filePath);
  return {
    signatureContent: filePath,
    abstractRule: extension ? `**/*${extension}` : '**/*',
  };
}

export function operationFailure(
  operation: string,
  error: unknown,
  abortedModel: string,
): ToolResult {
  const aborted = getErrorName(error) === 'AbortError';
  return {
    status: 'error',
    model: aborted ? abortedModel : `${operation} failed: ${getErrorMessage(error)}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: aborted ? 'Operation aborted' : getErrorMessage(error),
      details: error,
    },
  };
}

export async function runWriteGuard(options: {
  filePath: string;
  sessionId?: SessionId;
  messageId?: MessageId;
  operation: WriteOperation;
  fileExists: boolean;
  storageRoot?: string;
}): Promise<{
  blocked: ToolResult | null;
  snapshotCreated: boolean;
  snapshotWarning?: string;
}> {
  const { filePath, sessionId, messageId, operation, fileExists, storageRoot } = options;
  if (!fileExists) return { blocked: null, snapshotCreated: false };
  if (!sessionId) {
    return {
      blocked: {
        status: 'error',
        model:
          'Cannot verify read-before-write without a Session ID. Execute this file operation through an Agent or Session runtime.',
        error: {
          type: ToolErrorType.PERMISSION_DENIED,
          message: 'Session ID required for existing file writes',
        },
        metadata: { requiresRead: true, requiresSession: true },
      },
      snapshotCreated: false,
    };
  }

  const tracker = FileAccessTracker.getInstance();
  if (!tracker.hasFileBeenRead(filePath, sessionId)) {
    const action = operation === 'edit' ? 'editing' : 'writing';
    return {
      blocked: {
        status: 'error',
        model: `You must use the Read tool before ${action} this existing file.`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `File not read before ${operation}`,
        },
        metadata: { requiresRead: true },
      },
      snapshotCreated: false,
    };
  }
  const modification = await tracker.checkExternalModification(filePath, sessionId);
  if (modification.isExternal) {
    return {
      blocked: {
        status: 'error',
        model: `The file changed since it was read. Read it again before ${operation}.\n\nDetails: ${modification.message}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'File modified externally',
          details: { externalModification: modification.message },
        },
      },
      snapshotCreated: false,
    };
  }
  if (!messageId) return { blocked: null, snapshotCreated: false };

  try {
    const snapshots = SnapshotManager.getInstance({ sessionId, storageRoot });
    await snapshots.initialize();
    await snapshots.createSnapshot(filePath, messageId);
    return { blocked: null, snapshotCreated: true };
  } catch (error) {
    return {
      blocked: null,
      snapshotCreated: false,
      snapshotWarning: getErrorMessage(error),
    };
  }
}

export async function recordWriteComplete(
  filePath: string,
  sessionId: SessionId | undefined,
  operation: WriteOperation,
): Promise<void> {
  if (sessionId) {
    await FileAccessTracker.getInstance().recordFileEdit(filePath, sessionId, operation);
  }
}
