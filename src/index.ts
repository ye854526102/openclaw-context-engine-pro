/**
 * Context Engine Pro
 *
 * Advanced context management engine for OpenClaw
 *
 * @packageDocumentation
 */

// Export types
export type {
  AgentMessage,
  ContentBlock,
  PluginLogger,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  IngestBatchResult,
  BootstrapResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
  ContextEngineRuntimeContext,
  ContextEngine,
  OpenClawPluginApi,
  PluginConfigSchema,
  OpenClawPluginDefinition,
} from "./types.js";

// Export engine class and defaults
export { ContextEnginePro, DEFAULT_CONFIG } from "./engine.js";

// Export plugin
export { default as contextEngineProPlugin } from "./plugin.js";
export type { ContextEngineProConfig } from "./engine.js";
