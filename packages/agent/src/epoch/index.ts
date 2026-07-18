// Barrel export for epoch subsystem
// Handles execution epoch management — transactional
// boundaries for agent loop processing.

export {
  ExecutionEpoch,
  type AgentLoopToolResultEpochLike,
  shouldStopAgentLoopToolResultProcessing,
} from './ExecutionEpoch.js';
