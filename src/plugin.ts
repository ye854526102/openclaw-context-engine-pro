import type { OpenClawPluginApi, OpenClawPluginDefinition } from "./types.js";
import { ContextEnginePro, DEFAULT_CONFIG } from "./engine.js";
import type { ContextEngineProConfig } from "./engine.js";

export { ContextEnginePro, DEFAULT_CONFIG };
export type { ContextEngineProConfig };

/**
 * Context Engine Pro Plugin for OpenClaw
 *
 * An advanced context management engine that provides:
 * - Intelligent message prioritization during compaction
 * - Smart summarization preserving key information
 * - Optimized subagent context handling
 * - Configurable token budgets and thresholds
 *
 * Installation:
 *   openclaw plugins install @ye854526102/openclaw-context-engine-pro
 *
 * Configuration (openclaw.json):
 * {
 *   "plugins": {
 *     "entries": {
 *       "context-engine-pro": {
 *         "enabled": true,
 *         "config": {
 *           "compactionThreshold": 0.75,
 *           "preserveRecentTurns": 10,
 *           "priorityKeywords": ["important", "critical", "error"]
 *         }
 *       }
 *     },
 *     "slots": {
 *       "contextEngine": "context-engine-pro"
 *     }
 *   }
 * }
 */
const contextEngineProPlugin: OpenClawPluginDefinition = {
  id: "context-engine-pro",
  name: "Context Engine Pro",
  description:
    "Advanced context management with intelligent compaction, message prioritization, and token optimization",
  version: "1.0.0",
  kind: "context-engine",

  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      maxContextTokens: {
        type: "number",
        description: "Maximum context window size in tokens (0 = use model default)",
      },
      compactionThreshold: {
        type: "number",
        description: "Percentage of context window at which compaction triggers (0-1, default: 0.8)",
      },
      preserveRecentTurns: {
        type: "number",
        description: "Minimum recent conversation turns to always preserve during compaction (default: 5)",
      },
      enableSmartSummarization: {
        type: "boolean",
        description: "Use intelligent summarization that preserves key information (default: true)",
      },
      priorityKeywords: {
        type: "array",
        items: { type: "string" },
        description: "Keywords that indicate high-priority messages to preserve during compaction",
      },
      enableSubagentContext: {
        type: "boolean",
        description: "Enable specialized context handling for subagent spawns (default: true)",
      },
      maxSubagentContextTokens: {
        type: "number",
        description: "Maximum tokens to pass to subagents (0 = auto, half of parent context)",
      },
    },
  },

  register(api: OpenClawPluginApi): void {
    const pluginConfig = (api.pluginConfig as ContextEngineProConfig) || {};
    const config = { ...DEFAULT_CONFIG, ...pluginConfig };

    api.logger.info(
      `[context-engine-pro] Registering context engine with config: ` +
        `threshold=${config.compactionThreshold}, ` +
        `preserve=${config.preserveRecentTurns}, ` +
        `keywords=${config.priorityKeywords.length}`
    );

    // Register the context engine factory
    api.registerContextEngine("context-engine-pro", () => {
      return new ContextEnginePro(config, api.logger);
    });

    api.logger.info(`[context-engine-pro] Context engine registered successfully`);
  },
};

export default contextEngineProPlugin;
