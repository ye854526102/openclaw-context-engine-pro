/**
 * Context Engine Pro - Type Definitions
 *
 * These types are compatible with OpenClaw's plugin SDK.
 * When used with OpenClaw, the actual types from 'openclaw/plugin-sdk' will be used.
 */

/**
 * Agent message structure (compatible with @mariozechner/pi-agent-core)
 */
export type AgentMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: string; data?: string; url?: string; media_type?: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

/**
 * Plugin logger interface
 */
export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Context engine info
 */
export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
};

/**
 * Result of context assembly
 */
export type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

/**
 * Result of context compaction
 */
export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: Record<string, unknown>;
  };
};

/**
 * Result of message ingestion
 */
export type IngestResult = {
  ingested: boolean;
};

/**
 * Result of batch ingestion
 */
export type IngestBatchResult = {
  ingestedCount: number;
};

/**
 * Result of bootstrap
 */
export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

/**
 * Subagent spawn preparation
 */
export type SubagentSpawnPreparation = {
  rollback: () => void | Promise<void>;
};

/**
 * Subagent end reason
 */
export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

/**
 * Runtime context
 */
export type ContextEngineRuntimeContext = Record<string, unknown>;

/**
 * ContextEngine interface
 */
export interface ContextEngine {
  readonly info: ContextEngineInfo;
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult>;
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;
  dispose?(): Promise<void>;
}

/**
 * Plugin API interface (minimal for context engine)
 */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerContextEngine: (id: string, factory: () => ContextEngine | Promise<ContextEngine>) => void;
}

/**
 * Plugin configuration schema
 */
export type PluginConfigSchema = {
  type: "object";
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
};

/**
 * Plugin definition
 */
export interface OpenClawPluginDefinition {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: "memory" | "context-engine";
  configSchema?: PluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
}
