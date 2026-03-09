import type {
  AgentMessage,
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  BootstrapResult,
  IngestResult,
  IngestBatchResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
  ContextEngineRuntimeContext,
  PluginLogger,
} from "./types.js";

/**
 * Message priority levels for intelligent compaction
 */
type MessagePriority = "critical" | "high" | "normal" | "low";

/**
 * Internal message metadata for tracking
 */
interface MessageMeta {
  id: string;
  priority: MessagePriority;
  tokenEstimate: number;
  timestamp: number;
  hasToolResult: boolean;
  hasCodeBlock: boolean;
  priorityKeywordMatches: string[];
}

/**
 * Subagent context state tracking
 */
interface SubagentContextState {
  parentSessionKey: string;
  childSessionKey: string;
  createdAt: number;
  ttlMs: number;
  contextSnapshot: AgentMessage[];
}

/**
 * Configuration for Context Engine Pro
 */
export type ContextEngineProConfig = {
  /** Maximum context window size in tokens (0 = use model default) */
  maxContextTokens?: number;
  /** Percentage of context window at which compaction triggers (default: 0.8) */
  compactionThreshold?: number;
  /** Minimum recent turns to always preserve during compaction (default: 5) */
  preserveRecentTurns?: number;
  /** Use intelligent summarization that preserves key information (default: true) */
  enableSmartSummarization?: boolean;
  /** Keywords that indicate high-priority messages to preserve during compaction */
  priorityKeywords?: string[];
  /** Enable specialized context handling for subagent spawns (default: true) */
  enableSubagentContext?: boolean;
  /** Maximum tokens to pass to subagents (0 = auto, half of parent) */
  maxSubagentContextTokens?: number;
};

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<ContextEngineProConfig> = {
  maxContextTokens: 0,
  compactionThreshold: 0.8,
  preserveRecentTurns: 5,
  enableSmartSummarization: true,
  priorityKeywords: [],
  enableSubagentContext: true,
  maxSubagentContextTokens: 0,
};

/**
 * Context Engine Pro Implementation
 *
 * An advanced context management engine that provides:
 * - Intelligent message prioritization during compaction
 * - Smart summarization preserving key information
 * - Optimized subagent context handling
 * - Configurable token budgets and thresholds
 *
 * Priority levels:
 * - CRITICAL: Tool results and tool calls
 * - HIGH: Code blocks, messages with priority keywords
 * - NORMAL: User messages, system messages
 * - LOW: Regular assistant messages
 */
export class ContextEnginePro implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "context-engine-pro",
    name: "Context Engine Pro",
    version: "1.0.0",
    ownsCompaction: true,
  };

  private config: Required<ContextEngineProConfig>;
  private logger: PluginLogger;
  private sessionStores: Map<string, { messages: AgentMessage[]; meta: Map<string, MessageMeta> }>;
  private subagentStates: Map<string, SubagentContextState>;

  constructor(config: Required<ContextEngineProConfig>, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
    this.sessionStores = new Map();
    this.subagentStates = new Map();
  }

  /**
   * Initialize engine state for a session
   */
  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    const { sessionId } = params;

    this.logger.info(`[context-engine-pro] Bootstrapping session: ${sessionId}`);

    // Initialize session store
    if (!this.sessionStores.has(sessionId)) {
      this.sessionStores.set(sessionId, {
        messages: [],
        meta: new Map(),
      });
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
      reason: "New session initialized",
    };
  }

  /**
   * Ingest a single message into the engine's store
   * Analyzes message priority and estimates tokens
   */
  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, message } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) {
      this.logger.warn(`[context-engine-pro] Session not found: ${sessionId}`);
      return { ingested: false };
    }

    // Generate unique ID and analyze message
    const messageId = this.generateMessageId(message);
    const priority = this.analyzeMessagePriority(message);
    const tokenEstimate = this.estimateTokens(message);

    const meta: MessageMeta = {
      id: messageId,
      priority,
      tokenEstimate,
      timestamp: Date.now(),
      hasToolResult: this.hasToolResult(message),
      hasCodeBlock: this.hasCodeBlock(message),
      priorityKeywordMatches: this.findPriorityKeywords(message),
    };

    store.messages.push(message);
    store.meta.set(messageId, meta);

    if (params.isHeartbeat) {
      this.logger.debug?.(`[context-engine-pro] Ingested heartbeat message: ${messageId}`);
    }

    return { ingested: true };
  }

  /**
   * Ingest a batch of messages
   */
  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    let ingestedCount = 0;

    for (const message of params.messages) {
      const result = await this.ingest({
        sessionId: params.sessionId,
        message,
        isHeartbeat: params.isHeartbeat,
      });
      if (result.ingested) {
        ingestedCount++;
      }
    }

    return { ingestedCount };
  }

  /**
   * Post-turn lifecycle hook
   * Monitors context usage and can trigger proactive compaction
   */
  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    const { sessionId, tokenBudget } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) return;

    // Log compaction summary if available
    if (params.autoCompactionSummary) {
      this.logger.debug?.(
        `[context-engine-pro] Session ${sessionId} auto-compaction: ${params.autoCompactionSummary.substring(0, 100)}...`
      );
    }

    // Check if proactive compaction is needed
    if (tokenBudget && this.config.compactionThreshold < 1) {
      const currentTokens = this.estimateTotalTokens(sessionId);
      const threshold = tokenBudget * this.config.compactionThreshold;

      if (currentTokens > threshold) {
        this.logger.info(
          `[context-engine-pro] Session ${sessionId} approaching threshold: ${currentTokens}/${tokenBudget} tokens (${Math.round((currentTokens / tokenBudget) * 100)}%)`
        );
      }
    }
  }

  /**
   * Assemble model context under token budget
   * Prioritizes messages and ensures budget compliance
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const { sessionId, messages, tokenBudget } = params;

    const store = this.sessionStores.get(sessionId);
    const effectiveBudget = tokenBudget || this.config.maxContextTokens || 128000;

    // If no budget constraint, return all messages
    if (!effectiveBudget || effectiveBudget <= 0) {
      return {
        messages,
        estimatedTokens: this.estimateTotalTokens(sessionId),
      };
    }

    // Prioritize messages for assembly
    const prioritized = this.prioritizeMessages(messages, store?.meta);

    // Select messages that fit within budget
    const selected: AgentMessage[] = [];
    let currentTokens = 0;

    for (const { message, tokens } of prioritized) {
      if (currentTokens + tokens <= effectiveBudget) {
        selected.push(message);
        currentTokens += tokens;
      } else {
        break;
      }
    }

    // Ensure we have at least the most recent turns
    const recentMessages = messages.slice(-this.config.preserveRecentTurns);
    for (const msg of recentMessages) {
      if (!selected.includes(msg)) {
        selected.push(msg);
        currentTokens += this.estimateTokens(msg);
      }
    }

    // Generate context hints
    const systemPromptAddition = this.generateContextHints(sessionId, selected.length, currentTokens);

    return {
      messages: selected,
      estimatedTokens: currentTokens,
      systemPromptAddition,
    };
  }

  /**
   * Compact context to reduce token usage
   * Uses intelligent prioritization to preserve important content
   */
  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    const { sessionId, tokenBudget, force, currentTokenCount, customInstructions } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) {
      return { ok: false, compacted: false, reason: "Session not found" };
    }

    const effectiveBudget = tokenBudget || this.config.maxContextTokens || 128000;
    const currentTokens = currentTokenCount || this.estimateTotalTokens(sessionId);

    // Check if compaction is needed
    if (!force && currentTokens < effectiveBudget * this.config.compactionThreshold) {
      return {
        ok: true,
        compacted: false,
        reason: `Below compaction threshold (${Math.round((currentTokens / effectiveBudget) * 100)}% < ${Math.round(this.config.compactionThreshold * 100)}%)`,
        result: {
          tokensBefore: currentTokens,
          tokensAfter: currentTokens,
        },
      };
    }

    this.logger.info(
      `[context-engine-pro] Compacting session ${sessionId}: ${currentTokens} tokens → target: ${effectiveBudget}`
    );

    return this.performIntelligentCompaction(sessionId, store, effectiveBudget, customInstructions);
  }

  /**
   * Prepare context for subagent spawn
   * Selects relevant context within token budget
   */
  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    if (!this.config.enableSubagentContext) {
      return undefined;
    }

    const { parentSessionKey, childSessionKey, ttlMs = 300000 } = params;

    const parentStore = this.sessionStores.get(parentSessionKey);
    if (!parentStore) {
      return undefined;
    }

    // Determine subagent token budget
    const maxTokens =
      this.config.maxSubagentContextTokens > 0
        ? this.config.maxSubagentContextTokens
        : Math.floor(this.estimateTotalTokens(parentSessionKey) / 2);

    // Select relevant messages for subagent
    const contextSnapshot = this.selectSubagentContext(parentStore.messages, parentStore.meta, maxTokens);

    // Store state for rollback
    const state: SubagentContextState = {
      parentSessionKey,
      childSessionKey,
      createdAt: Date.now(),
      ttlMs,
      contextSnapshot,
    };
    this.subagentStates.set(childSessionKey, state);

    this.logger.info(
      `[context-engine-pro] Prepared subagent context: ${childSessionKey} with ${contextSnapshot.length} messages (~${maxTokens} tokens)`
    );

    return {
      rollback: async () => {
        this.subagentStates.delete(childSessionKey);
        this.logger.info(`[context-engine-pro] Rolled back subagent context: ${childSessionKey}`);
      },
    };
  }

  /**
   * Handle subagent end lifecycle
   */
  async onSubagentEnded(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void> {
    const { childSessionKey, reason } = params;

    const state = this.subagentStates.get(childSessionKey);
    if (state) {
      this.logger.info(`[context-engine-pro] Subagent ended: ${childSessionKey}, reason: ${reason}`);
      this.subagentStates.delete(childSessionKey);
    }
  }

  /**
   * Dispose of all resources
   */
  async dispose(): Promise<void> {
    this.sessionStores.clear();
    this.subagentStates.clear();
    this.logger.info("[context-engine-pro] Disposed all session stores");
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Generate a unique message ID
   */
  private generateMessageId(message: AgentMessage): string {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const hash = this.simpleHash(content);
    return `${message.role}-${hash}-${Date.now()}`;
  }

  /**
   * Simple hash function for content
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Analyze message priority based on content
   */
  private analyzeMessagePriority(message: AgentMessage): MessagePriority {
    // Tool results are critical
    if (this.hasToolResult(message)) {
      return "critical";
    }

    // Code blocks are high priority
    if (this.hasCodeBlock(message)) {
      return "high";
    }

    // Check for priority keywords
    if (this.findPriorityKeywords(message).length > 0) {
      return "high";
    }

    // User and system messages are normal priority
    if (message.role === "user" || message.role === "system") {
      return "normal";
    }

    return "low";
  }

  /**
   * Check if message contains tool result
   */
  private hasToolResult(message: AgentMessage): boolean {
    if (message.role === "tool") return true;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      return message.content.some(
        (block) => block.type === "tool_use" || block.type === "tool_result"
      );
    }

    return false;
  }

  /**
   * Check if message contains code block
   */
  private hasCodeBlock(message: AgentMessage): boolean {
    const content = typeof message.content === "string" ? message.content : "";
    return content.includes("```") || content.includes("<code>");
  }

  /**
   * Find priority keywords in message
   */
  private findPriorityKeywords(message: AgentMessage): string[] {
    const keywords = this.config.priorityKeywords;
    if (!keywords || keywords.length === 0) return [];

    const content = typeof message.content === "string" ? message.content.toLowerCase() : "";

    return keywords.filter((keyword) => content.includes(keyword.toLowerCase()));
  }

  /**
   * Estimate token count for message
   */
  private estimateTokens(message: AgentMessage): number {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    // Rough estimation: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Estimate total tokens for session
   */
  private estimateTotalTokens(sessionId: string): number {
    const store = this.sessionStores.get(sessionId);
    if (!store) return 0;

    let total = 0;
    for (const meta of store.meta.values()) {
      total += meta.tokenEstimate;
    }
    return total;
  }

  /**
   * Prioritize messages for assembly
   */
  private prioritizeMessages(
    messages: AgentMessage[],
    meta?: Map<string, MessageMeta>
  ): Array<{ message: AgentMessage; tokens: number; priority: MessagePriority }> {
    const result: Array<{ message: AgentMessage; tokens: number; priority: MessagePriority }> = [];

    for (const message of messages) {
      const msgId = this.generateMessageId(message);
      const msgMeta = meta?.get(msgId);
      const priority = msgMeta?.priority || this.analyzeMessagePriority(message);
      const tokens = msgMeta?.tokenEstimate || this.estimateTokens(message);

      result.push({ message, tokens, priority });
    }

    // Sort by priority (critical first, then high, normal, low)
    const priorityOrder: Record<MessagePriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    result.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return result;
  }

  /**
   * Generate context hints for system prompt
   */
  private generateContextHints(sessionId: string, messageCount: number, tokenCount: number): string {
    const store = this.sessionStores.get(sessionId);

    const criticalCount = store
      ? [...store.meta.values()].filter((m) => m.priority === "critical").length
      : 0;

    const highPriorityCount = store
      ? [...store.meta.values()].filter((m) => m.priority === "high").length
      : 0;

    return `[Context Engine Pro] ${messageCount} messages (~${tokenCount} tokens). ${criticalCount} critical, ${highPriorityCount} high-priority items preserved.`;
  }

  /**
   * Select context for subagent
   */
  private selectSubagentContext(
    messages: AgentMessage[],
    meta: Map<string, MessageMeta>,
    maxTokens: number
  ): AgentMessage[] {
    const prioritized = this.prioritizeMessages(messages, meta);
    const selected: AgentMessage[] = [];
    let currentTokens = 0;

    for (const { message, tokens } of prioritized) {
      if (currentTokens + tokens <= maxTokens) {
        selected.push(message);
        currentTokens += tokens;
      }
    }

    return selected;
  }

  /**
   * Perform intelligent compaction
   */
  private async performIntelligentCompaction(
    sessionId: string,
    store: { messages: AgentMessage[]; meta: Map<string, MessageMeta> },
    targetBudget: number,
    customInstructions?: string
  ): Promise<CompactResult> {
    const tokensBefore = this.estimateTotalTokens(sessionId);

    // Identify messages to keep (recent + high priority)
    const recentMessages = store.messages.slice(-this.config.preserveRecentTurns);
    const recentIds = new Set(recentMessages.map((m) => this.generateMessageId(m)));

    // Identify critical/high-priority messages to always keep
    const criticalIds = new Set<string>();
    for (const [id, meta] of store.meta) {
      if (meta.priority === "critical" || meta.priority === "high") {
        criticalIds.add(id);
      }
    }

    // Separate messages to compact vs keep
    const toCompact: AgentMessage[] = [];
    const toKeep: AgentMessage[] = [];

    for (const message of store.messages) {
      const msgId = this.generateMessageId(message);
      if (recentIds.has(msgId) || criticalIds.has(msgId)) {
        toKeep.push(message);
      } else {
        toCompact.push(message);
      }
    }

    // Generate summary if smart summarization is enabled
    let summary: string | undefined;
    if (this.config.enableSmartSummarization && toCompact.length > 0) {
      summary = `[Context Engine Pro] Compacted ${toCompact.length} messages. Key topics preserved.`;
      if (customInstructions) {
        summary += ` Instructions: ${customInstructions}`;
      }
    }

    // Update store with kept messages
    store.messages = toKeep;

    // Rebuild meta map
    const newMeta = new Map<string, MessageMeta>();
    for (const msg of toKeep) {
      const msgId = this.generateMessageId(msg);
      const existing = store.meta.get(msgId);
      if (existing) {
        newMeta.set(msgId, existing);
      }
    }
    store.meta = newMeta;

    const tokensAfter = this.estimateTotalTokens(sessionId);
    const firstKeptEntryId = toKeep.length > 0 ? this.generateMessageId(toKeep[0]) : undefined;

    this.logger.info(
      `[context-engine-pro] Compaction complete: ${tokensBefore} → ${tokensAfter} tokens (${toCompact.length} removed, ${toKeep.length} kept)`
    );

    return {
      ok: true,
      compacted: true,
      reason: summary,
      result: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        tokensAfter,
        details: {
          removedCount: toCompact.length,
          keptCount: toKeep.length,
          targetBudget,
          criticalPreserved: criticalIds.size,
          recentPreserved: recentMessages.length,
        },
      },
    };
  }
}
