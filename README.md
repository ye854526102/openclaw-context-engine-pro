# @ye854526102/openclaw-context-engine-pro

**[中文文档](./README_CN.md)** | **English**

> Advanced context management engine for [OpenClaw](https://github.com/openclaw/openclaw) with intelligent compaction, message prioritization, and token optimization.

[![npm version](https://img.shields.io/npm/v/@ye854526102/openclaw-context-engine-pro.svg)](https://www.npmjs.com/package/@ye854526102/openclaw-context-engine-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **🎯 Intelligent Message Prioritization** - Automatically categorizes messages by priority (critical, high, normal, low)
- **📊 Smart Compaction** - Preserves important context while reducing token usage
- **⚙️ Configurable Thresholds** - Set custom compaction triggers based on token percentage
- **🤖 Subagent Context Optimization** - Optimized context handling for spawned subagents
- **🔑 Priority Keywords** - Define keywords that mark messages as high-priority
- **📈 Token Budget Management** - Fine-grained control over context window usage

## Installation

```bash
# Install via npm
npm install @ye854526102/openclaw-context-engine-pro

# Or install via OpenClaw CLI
openclaw plugins install @ye854526102/openclaw-context-engine-pro
```

## Quick Start

Add to your `openclaw.json` configuration:

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true,
        "config": {
          "compactionThreshold": 0.75,
          "preserveRecentTurns": 10,
          "priorityKeywords": ["important", "critical", "error", "must"]
        }
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

Restart OpenClaw Gateway:

```bash
openclaw gateway restart
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxContextTokens` | `number` | `0` | Maximum context window size in tokens. Set to `0` to use the model's default. |
| `compactionThreshold` | `number` | `0.8` | Percentage of context window (0-1) at which compaction triggers. |
| `preserveRecentTurns` | `number` | `5` | Minimum recent conversation turns to always preserve during compaction. |
| `enableSmartSummarization` | `boolean` | `true` | Use intelligent summarization that preserves key information. |
| `priorityKeywords` | `string[]` | `[]` | Keywords that indicate high-priority messages to preserve during compaction. |
| `enableSubagentContext` | `boolean` | `true` | Enable specialized context handling for subagent spawns. |
| `maxSubagentContextTokens` | `number` | `0` | Maximum tokens to pass to subagents. Set to `0` for auto (half of parent context). |

## How It Works

### Message Prioritization

Messages are automatically categorized into priority levels:

| Priority | Description |
|----------|-------------|
| **Critical** | Tool calls and tool results - essential for agent function |
| **High** | Code blocks, messages matching priority keywords |
| **Normal** | User messages, system messages |
| **Low** | Regular assistant messages |

### Compaction Process

When context reaches the configured threshold:

1. **Identify Protected Messages**
   - Recent N turns (configurable via `preserveRecentTurns`)
   - All critical and high-priority messages

2. **Compact Lower Priority Content**
   - Remove low-priority messages
   - Optionally summarize compacted content

3. **Preserve Key Information**
   - Tool results and code blocks
   - Messages containing priority keywords
   - Recent conversation context

### Subagent Context

When spawning subagents:

1. Analyze parent context for relevant information
2. Select high-priority and relevant messages
3. Pass optimized context to child session
4. Track subagent lifecycle for potential context merging

## API Reference

This plugin implements OpenClaw's `ContextEngine` interface:

```typescript
interface ContextEngine {
  // Lifecycle
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
  dispose?(): Promise<void>;

  // Message handling
  ingest(params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>;
  ingestBatch?(params: { sessionId: string; messages: AgentMessage[]; isHeartbeat?: boolean }): Promise<IngestBatchResult>;

  // Context management
  assemble(params: { sessionId: string; messages: AgentMessage[]; tokenBudget?: number }): Promise<AssembleResult>;
  compact(params: { sessionId: string; sessionFile: string; tokenBudget?: number; force?: boolean; ... }): Promise<CompactResult>;
  afterTurn?(params: { sessionId: string; sessionFile: string; messages: AgentMessage[]; ... }): Promise<void>;

  // Subagent support
  prepareSubagentSpawn?(params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch for changes
npm run build:watch

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Project Structure

```
├── src/
│   ├── index.ts          # Main entry point
│   ├── types.ts          # TypeScript type definitions
│   ├── engine.ts         # ContextEngine implementation
│   ├── plugin.ts         # OpenClaw plugin definition
│   └── engine.test.ts    # Unit tests
├── openclaw.plugin.json  # Plugin manifest
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Requirements

- OpenClaw >= 2026.3.7
- Node.js >= 18.0.0

## License

MIT © [ye854526102](https://github.com/ye854526102)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) - The AI agent framework this plugin is designed for
- [Context Engine Documentation](https://github.com/openclaw/openclaw/blob/main/docs/tools/plugin.md) - OpenClaw plugin development guide
