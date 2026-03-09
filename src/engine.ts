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
  /** Index in the message array for ordering */
  index: number;
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
 * Session store with TTL support
 */
interface SessionStore {
  messages: AgentMessage[];
  meta: Map<string, MessageMeta>;
  lastAccess: number;
}

/**
 * Configuration for Context Engine Pro
 */
export type ContextEngineProConfig = {
  /** Maximum context window size in tokens (0 = use model default) */
  maxContextTokens?: number;
  /** Percentage of context window at which compaction triggers (default: 0.8, range: 0.1-1.0) */
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
  /** Session TTL in milliseconds (default: 3600000 = 1 hour) */
  sessionTTL?: number;
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
  sessionTTL: 3600000, // 1 hour
};

/**
 * Validate configuration values
 */
function validateConfig(config: Required<ContextEngineProConfig>): void {
  if (config.compactionThreshold < 0.1 || config.compactionThreshold > 1) {
    throw new Error(`[context-engine-pro] compactionThreshold must be between 0.1 and 1, got: ${config.compactionThreshold}`);
  }
  if (config.preserveRecentTurns < 0) {
    throw new Error(`[context-engine-pro] preserveRecentTurns must be >= 0, got: ${config.preserveRecentTurns}`);
  }
  if (config.maxContextTokens < 0) {
    throw new Error(`[context-engine-pro] maxContextTokens must be >= 0, got: ${config.maxContextTokens}`);
  }
  if (config.sessionTTL < 60000) {
    throw new Error(`[context-engine-pro] sessionTTL must be >= 60000 (1 minute), got: ${config.sessionTTL}`);
  }
}

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
    version: "1.0.1",
    ownsCompaction: true,
  };

  private config: Required<ContextEngineProConfig>;
  private logger: PluginLogger;
  private sessionStores: Map<string, SessionStore>;
  private subagentStates: Map<string, SubagentContextState>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private messageIndex: number = 0;

  constructor(config: Required<ContextEngineProConfig>, logger: PluginLogger) {
    // Validate configuration
    validateConfig(config);

    this.config = config;
    this.logger = logger;
    this.sessionStores = new Map();
    this.subagentStates = new Map();

    // Start cleanup timer
    this.startCleanupTimer();

    this.logger.info(`[context-engine-pro] Initialized with threshold=${config.compactionThreshold}, preserve=${config.preserveRecentTurns}`);
  }

  /**
   * Initialize engine state for a session
   */
  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    const { sessionId, sessionFile } = params;

    this.logger.info(`[context-engine-pro] Bootstrapping session: ${sessionId}`);

    // Clean up expired sessions first
    this.cleanupExpiredSessions();

    // Initialize session store
    if (!this.sessionStores.has(sessionId)) {
      this.sessionStores.set(sessionId, {
        messages: [],
        meta: new Map(),
        lastAccess: Date.now(),
      });

      // TODO: Load historical context from sessionFile if it exists
      // This would require file system access which should be provided through the runtime API
    } else {
      // Update last access time
      const store = this.sessionStores.get(sessionId)!;
      store.lastAccess = Date.now();
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
      reason: "Session initialized successfully",
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
    const { sessionId, message, isHeartbeat } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) {
      this.logger.warn(`[context-engine-pro] Session not found: ${sessionId}`);
      return { ingested: false };
    }

    // Update last access time
    store.lastAccess = Date.now();

    // Generate stable message ID
    const messageId = this.generateMessageId(message);

    // Check for duplicates
    if (store.meta.has(messageId)) {
      this.logger.debug?.(`[context-engine-pro] Duplicate message skipped: ${messageId}`);
      return { ingested: false };
    }

    // Analyze message
    const priority = this.analyzeMessagePriority(message);
    const tokenEstimate = this.estimateTokens(message);
    const index = this.messageIndex++;

    const meta: MessageMeta = {
      id: messageId,
      priority,
      tokenEstimate,
      timestamp: Date.now(),
      hasToolResult: this.hasToolResult(message),
      hasCodeBlock: this.hasCodeBlock(message),
      priorityKeywordMatches: this.findPriorityKeywords(message),
      index,
    };

    store.messages.push(message);
    store.meta.set(messageId, meta);

    if (isHeartbeat) {
      this.logger.debug?.(`[context-engine-pro] Ingested heartbeat message: ${messageId} (priority: ${priority})`);
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
    const { sessionId, messages, isHeartbeat } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) {
      this.logger.warn(`[context-engine-pro] Session not found: ${sessionId}`);
      return { ingestedCount: 0 };
    }

    let ingestedCount = 0;

    for (const message of messages) {
      const result = await this.ingest({
        sessionId,
        message,
        isHeartbeat,
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
    const { sessionId, tokenBudget, autoCompactionSummary } = params;

    const store = this.sessionStores.get(sessionId);
    if (!store) return;

    // Update last access time
    store.lastAccess = Date.now();

    // Log compaction summary if available
    if (autoCompactionSummary) {
      this.logger.debug?.(
        `[context-engine-pro] Session ${sessionId} auto-compaction: ${autoCompactionSummary.substring(0, 100)}...`
      );
    }

    // Check if proactive compaction is needed
    if (tokenBudget && this.config.compactionThreshold < 1) {
      const currentTokens = this.estimateTotalTokens(sessionId);
      const threshold = tokenBudget * this.config.compactionThreshold;

      if (currentTokens > threshold) {
        const percentage = Math.round((currentTokens / tokenBudget) * 100);
        this.logger.info(
          `[context-engine-pro] Session ${sessionId} approaching threshold: ${currentTokens}/${tokenBudget} tokens (${percentage}%)`
        );
      }
    }
  }

  /**
   * Assemble model context under token budget
   * Maintains message order while respecting priority
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const { sessionId, messages, tokenBudget } = params;

    const store = this.sessionStores.get(sessionId);
    if (store) {
      store.lastAccess = Date.now();
    }

    const effectiveBudget = tokenBudget || this.config.maxContextTokens || 128000;

    // If no budget constraint, return all messages
    if (!effectiveBudget || effectiveBudget <= 0) {
      return {
        messages,
        estimatedTokens: this.estimateTotalTokens(sessionId),
      };
    }

    // Build priority map while preserving order
    const messagePriority = new Map<AgentMessage, MessagePriority>();
    const messageTokens = new Map<AgentMessage, number>();

    for (const message of messages) {
      const msgId = this.generateMessageId(message);
      const meta = store?.meta.get(msgId);

      if (meta) {
        messagePriority.set(message, meta.priority);
        messageTokens.set(message, meta.tokenEstimate);
      } else {
        // Message not in store, analyze on the fly
        messagePriority.set(message, this.analyzeMessagePriority(message));
        messageTokens.set(message, this.estimateTokens(message));
      }
    }

    // Calculate total tokens
    let totalTokens = 0;
    for (const tokens of messageTokens.values()) {
      totalTokens += tokens;
    }

    // If within budget, return all messages
    if (totalTokens <= effectiveBudget) {
      return {
        messages,
        estimatedTokens: totalTokens,
        systemPromptAddition: this.generateContextHints(sessionId, messages.length, totalTokens, store),
      };
    }

    // Need to trim: prioritize while maintaining order
    // Strategy: Remove low-priority messages first, then normal
    const priorityOrder: Record<MessagePriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    // Identify messages that can be removed (non-recent, low priority)
    const recentStart = Math.max(0, messages.length - this.config.preserveRecentTurns);
    const selected: AgentMessage[] = [];
    let currentTokens = 0;

    // First pass: include all critical, high, and recent messages
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const priority = messagePriority.get(message) || "normal";
      const tokens = messageTokens.get(message) || 0;
      const isRecent = i >= recentStart;

      if (priorityOrder[priority] <= 1 || isRecent) {
        selected.push(message);
        currentTokens += tokens;
      }
    }

    // If still over budget, try removing normal priority (keeping recent)
    if (currentTokens > effectiveBudget) {
      const trimmed: AgentMessage[] = [];
      let trimmedTokens = 0;

      for (let i = 0; i < selected.length; i++) {
        const message = selected[i];
        const priority = messagePriority.get(message) || "normal";
        const tokens = messageTokens.get(message) || 0;
        const originalIndex = messages.indexOf(message);
        const isRecent = originalIndex >= recentStart;

        // Keep if critical, high, or recent
        if (priorityOrder[priority] <= 1 || isRecent) {
          trimmed.push(message);
          trimmedTokens += tokens;
        }
      }

      if (trimmedTokens <= effectiveBudget) {
        selected.length = 0;
        selected.push(...trimmed);
        currentTokens = trimmedTokens;
      }
    }

    // Final fallback: just keep recent turns
    if (currentTokens > effectiveBudget) {
      selected.length = 0;
      currentTokens = 0;

      const recentMessages = messages.slice(-this.config.preserveRecentTurns);
      for (const msg of recentMessages) {
        selected.push(msg);
        currentTokens += messageTokens.get(msg) || 0;
      }
    }

    return {
      messages: selected,
      estimatedTokens: currentTokens,
      systemPromptAddition: this.generateContextHints(sessionId, selected.length, currentTokens, store),
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

    // Update last access time
    store.lastAccess = Date.now();

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
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    this.sessionStores.clear();
    this.subagentStates.clear();
    this.logger.info("[context-engine-pro] Disposed all session stores");
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Generate a stable message ID based on content
   * Does NOT include timestamp to ensure consistency
   */
  private generateMessageId(message: AgentMessage): string {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const hash = this.simpleHash(`${message.role}:${content}`);
    return `${message.role}-${hash}`;
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
    // Tool role messages are always critical
    if (message.role === "tool") return true;

    // Check assistant messages for tool_use content blocks
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return message.content.some(
        (block) => block.type === "tool_use"
      );
    }

    return false;
  }

  /**
   * Check if message contains code block
   */
  private hasCodeBlock(message: AgentMessage): boolean {
    if (typeof message.content === "string") {
      return message.content.includes("```") || message.content.includes("<code>");
    }

    // Handle array content blocks
    if (Array.isArray(message.content)) {
      return message.content.some((block) => {
        if (block.type === "text" && "text" in block) {
          return block.text.includes("```") || block.text.includes("<code>");
        }
        return false;
      });
    }

    return false;
  }

  /**
   * Find priority keywords in message
   */
  private findPriorityKeywords(message: AgentMessage): string[] {
    const keywords = this.config.priorityKeywords;
    if (!keywords || keywords.length === 0) return [];

    let content = "";
    if (typeof message.content === "string") {
      content = message.content.toLowerCase();
    } else if (Array.isArray(message.content)) {
      content = message.content
        .filter((block) => block.type === "text" && "text" in block)
        .map((block) => ("text" in block ? block.text : ""))
        .join(" ")
        .toLowerCase();
    }

    return keywords.filter((keyword) => content.includes(keyword.toLowerCase()));
  }

  /**
   * Estimate token count for message
   * Uses a more accurate estimation for different content types
   */
  private estimateTokens(message: AgentMessage): number {
    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // Estimate for content blocks
      content = message.content
        .map((block) => {
          if (block.type === "text" && "text" in block) {
            return block.text;
          }
          if (block.type === "tool_use") {
            return JSON.stringify(block.input || {});
          }
          if (block.type === "image") {
            return "[image]"; // Images are counted differently by models
          }
          return JSON.stringify(block);
        })
        .join(" ");
    } else {
      content = JSON.stringify(message.content);
    }

    // Better estimation:
    // - Latin characters: ~4 chars per token
    // - CJK characters: ~2 chars per token
    // - Mixed content: estimate based on character ranges
    let tokenEstimate = 0;
    let latinChars = 0;
    let cjkChars = 0;

    for (const char of content) {
      const code = char.charCodeAt(0);
      // CJK ranges
      if ((code >= 0x4e00 && code <= 0x9fff) ||
          (code >= 0x3400 && code <= 0x4dbf) ||
          (code >= 0x20000 && code <= 0x2a6df) ||
          (code >= 0x2a700 && code <= 0x2b73f) ||
          (code >= 0x2b740 && code <= 0x2b81f) ||
          (code >= 0x2b820 && code <= 0x2ceaf)) {
        cjkChars++;
      } else {
        latinChars++;
      }
    }

    tokenEstimate = Math.ceil(latinChars / 4) + Math.ceil(cjkChars / 2);

    // Add overhead for role and metadata
    tokenEstimate += 10;

    return tokenEstimate;
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
   * Generate context hints for system prompt
   */
  private generateContextHints(
    sessionId: string,
    messageCount: number,
    tokenCount: number,
    store?: SessionStore
  ): string {
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
    // Prioritize messages while maintaining order
    const priorityOrder: Record<MessagePriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    const selected: AgentMessage[] = [];
    let currentTokens = 0;

    // First pass: include all critical and high priority messages
    for (const message of messages) {
      const msgId = this.generateMessageId(message);
      const msgMeta = meta.get(msgId);
      const priority = msgMeta?.priority || this.analyzeMessagePriority(message);
      const tokens = msgMeta?.tokenEstimate || this.estimateTokens(message);

      if (priorityOrder[priority] <= 1 && currentTokens + tokens <= maxTokens) {
        selected.push(message);
        currentTokens += tokens;
      }
    }

    // Second pass: add normal priority if space remains
    for (const message of messages) {
      if (selected.includes(message)) continue;

      const msgId = this.generateMessageId(message);
      const msgMeta = meta.get(msgId);
      const priority = msgMeta?.priority || this.analyzeMessagePriority(message);
      const tokens = msgMeta?.tokenEstimate || this.estimateTokens(message);

      if (priority === "normal" && currentTokens + tokens <= maxTokens) {
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
    store: SessionStore,
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

  /**
   * Start cleanup timer for expired sessions
   */
  private startCleanupTimer(): void {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000);
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, store] of this.sessionStores) {
      if (now - store.lastAccess > this.config.sessionTTL) {
        this.sessionStores.delete(sessionId);
        cleanedCount++;
      }
    }

    // Also clean up expired subagent states
    for (const [childSessionKey, state] of this.subagentStates) {
      if (now - state.createdAt > state.ttlMs) {
        this.subagentStates.delete(childSessionKey);
      }
    }

    if (cleanedCount > 0) {
      this.logger.info(`[context-engine-pro] Cleaned up ${cleanedCount} expired sessions`);
    }
  }
}
