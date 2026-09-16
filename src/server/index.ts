// Deprecated compatibility facade. New deployments should import
// @blade-ai/agent-sdk/server/infra and low-level controls from /advanced.
export * from '../execution/index.js';
export * from '../index.js';
export {
  coveredRequestOf,
  hasHistoryGap,
  type SessionHistoryProgress,
} from '../session/historyProgress.js';
export {
  type DurableHistoryProjection,
  type HistoryRepairOptions,
  type HistoryRepairReason,
  type HistoryRepairResult,
  projectDurableHistory,
  repairSessionHistory,
} from '../session/historyRepair.js';
export {
  EffectDispatcher,
  type EffectDispatcherMetrics,
  type EffectDispatcherOptions,
  RetryableRuntimeEffectError,
  type RuntimeEffectHandler,
  type RuntimeEffectHandlerContext,
  UncertainRuntimeEffectError,
} from './EffectDispatcher.js';
export {
  EXECUTION_HOST_ROUTE_METADATA_KEY,
  EXECUTION_HOST_ROUTE_METADATA_VERSION,
  type ExecutionCheckpointPolicy,
  type ExecutionHostSessionPlan,
  ExecutionHostSessionRunner,
  type ExecutionHostSessionRunnerOptions,
} from './ExecutionHostSessionRunner.js';
export * from './runtime.js';
export {
  SdkSessionRunner,
  type SdkSessionRunnerOptions,
  type SdkSessionRunnerOptionsContext,
} from './SdkSessionRunner.js';
export type {
  ActiveRuntimeSessionState,
  SessionRunner,
  SessionRunnerContext,
  SessionRunResult,
} from './SessionRunner.js';
