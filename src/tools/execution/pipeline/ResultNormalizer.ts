import type { ToolResult } from '../../types/result.js';
import { ResultArtifactStore } from '../ResultArtifactStore.js';
import { truncateStringResult } from './results.js';
import type { PipelineExecutionState } from './state.js';

/**
 * Normalizes a tool result before hooks and history observe it.
 *
 * Oversized model output is externalized to a session artifact when possible and
 * truncated otherwise; the summary metadata always records the original length
 * so callers can tell the difference between "small result" and "lost output".
 */
export class ResultNormalizer {
  constructor(private readonly artifacts = new ResultArtifactStore()) {}

  async normalize(state: PipelineExecutionState): Promise<ToolResult> {
    const result = state.result;
    if (!result) {
      throw new Error('Tool execution result not set');
    }

    if (result.model === '' || result.model === null) {
      result.model = 'Execution completed';
    }

    if (!result.metadata) {
      result.metadata = {};
    }

    const maxResultSizeChars = state.tool.maxResultSizeChars ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(maxResultSizeChars) && maxResultSizeChars >= 0) {
      const modelContentLength = typeof result.model === 'string' ? result.model.length : undefined;
      const exceedsLimit =
        modelContentLength !== undefined && modelContentLength > maxResultSizeChars;

      if (exceedsLimit) {
        try {
          const artifact = await this.artifacts.persist({
            executionId: state.context.sessionId || state.toolName,
            sessionId: state.context.sessionId,
            toolName: state.toolName,
            context: state.context,
            modelContent: typeof result.model === 'string' ? result.model : undefined,
          });
          const summary = `[externalized result to ${artifact.path}]`;
          if (modelContentLength !== undefined) {
            result.model = summary;
            result.metadata.modelContentOriginalLength = modelContentLength;
          }
          result.metadata.resultExternalized = true;
          result.metadata.resultArtifactPath = artifact.path;
          result.metadata.resultSizeLimit = maxResultSizeChars;
        } catch {
          const modelContent = truncateStringResult(result.model, maxResultSizeChars);
          if (modelContent) {
            result.model = modelContent.value;
            result.metadata.resultTruncated = true;
            result.metadata.resultSizeLimit = maxResultSizeChars;
            result.metadata.modelContentOriginalLength = modelContent.originalLength;
          }
        }
      } else {
        const modelContent = truncateStringResult(result.model, maxResultSizeChars);
        if (modelContent) {
          result.model = modelContent.value;
          result.metadata.resultTruncated = true;
          result.metadata.resultSizeLimit = maxResultSizeChars;
          result.metadata.modelContentOriginalLength = modelContent.originalLength;
        }
      }
    }

    result.metadata.executionId = state.context.sessionId;
    result.metadata.toolName = state.toolName;
    result.metadata.timestamp = Date.now();

    state.result = result;
    return result;
  }
}
