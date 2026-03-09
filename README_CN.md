# @ye854526102/openclaw-context-engine-pro

**中文文档** | **[English](./README.md)**

> OpenClaw 高级上下文管理引擎，支持智能压缩、消息优先级排序和 Token 优化。

[![npm version](https://img.shields.io/npm/v/@ye854526102/openclaw-context-engine-pro.svg)](https://www.npmjs.com/package/@ye854526102/openclaw-context-engine-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-ye854526102-blue.svg)](https://github.com/ye854526102/openclaw-context-engine-pro)

## 功能特性

- **🎯 智能消息优先级分析** - 自动将消息分类为关键、高、普通、低四个优先级
- **📊 智能上下文压缩** - 在保留重要信息的同时减少 Token 使用量
- **⚙️ 可配置压缩阈值** - 根据上下文窗口百分比自定义压缩触发时机
- **🤖 子代理上下文优化** - 为子代理提供精简但重要的上下文
- **🔑 优先关键词** - 定义关键词，包含这些词的消息将被优先保留
- **📈 Token 预算管理** - 精细控制上下文窗口使用量

## 安装

```bash
# 通过 npm 安装
npm install @ye854526102/openclaw-context-engine-pro

# 或通过 OpenClaw CLI 安装
openclaw plugins install @ye854526102/openclaw-context-engine-pro
```

## 快速开始

在 `openclaw.json` 配置文件中添加：

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true,
        "config": {
          "compactionThreshold": 0.75,
          "preserveRecentTurns": 10,
          "priorityKeywords": ["重要", "关键", "错误", "必须"]
        }
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxContextTokens` | `number` | `0` | 最大上下文窗口大小（Token）。设置为 `0` 使用模型默认值。 |
| `compactionThreshold` | `number` | `0.8` | 触发压缩的上下文窗口百分比（0-1）。 |
| `preserveRecentTurns` | `number` | `5` | 压缩时始终保留的最近对话轮数。 |
| `enableSmartSummarization` | `boolean` | `true` | 启用智能摘要，保留关键信息。 |
| `priorityKeywords` | `string[]` | `[]` | 高优先级关键词列表，包含这些词的消息会被优先保留。 |
| `enableSubagentContext` | `boolean` | `true` | 启用子代理上下文优化。 |
| `maxSubagentContextTokens` | `number` | `0` | 传递给子代理的最大 Token 数。设置为 `0` 自动使用父上下文的一半。 |

## 工作原理

### 消息优先级分析

消息会被自动分为四个优先级：

| 优先级 | 说明 |
|--------|------|
| **Critical（关键）** | 工具调用和工具结果 - 对代理功能至关重要 |
| **High（高）** | 代码块、匹配优先关键词的消息 |
| **Normal（普通）** | 用户消息、系统消息 |
| **Low（低）** | 普通助手消息 |

### 压缩流程

当上下文达到配置的阈值时：

1. **识别受保护消息**
   - 最近 N 轮对话（通过 `preserveRecentTurns` 配置）
   - 所有关键和高优先级消息

2. **压缩低优先级内容**
   - 移除低优先级消息
   - 可选生成摘要保留关键信息

3. **保留重要信息**
   - 工具结果和代码块
   - 包含优先关键词的消息
   - 最近的对话上下文

### 子代理上下文

当创建子代理时：

1. 分析父上下文中的相关信息
2. 选择高优先级和相关的消息
3. 将优化后的上下文传递给子会话
4. 跟踪子代理生命周期以支持上下文合并

## 使用示例

### 基础配置

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

### 自定义优先关键词

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true,
        "config": {
          "priorityKeywords": [
            "重要",
            "关键",
            "错误",
            "error",
            "critical",
            "必须记住",
            "不要忘记"
          ]
        }
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

### 激进压缩配置

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true,
        "config": {
          "compactionThreshold": 0.6,
          "preserveRecentTurns": 3,
          "enableSmartSummarization": true
        }
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

### 保守压缩配置

```json
{
  "plugins": {
    "entries": {
      "context-engine-pro": {
        "enabled": true,
        "config": {
          "compactionThreshold": 0.9,
          "preserveRecentTurns": 10,
          "priorityKeywords": ["重要", "关键"]
        }
      }
    },
    "slots": {
      "contextEngine": "context-engine-pro"
    }
  }
}
```

## API 参考

本插件实现了 OpenClaw 的 `ContextEngine` 接口：

```typescript
interface ContextEngine {
  // 生命周期
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
  dispose?(): Promise<void>;

  // 消息处理
  ingest(params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>;
  ingestBatch?(params: { sessionId: string; messages: AgentMessage[]; isHeartbeat?: boolean }): Promise<IngestBatchResult>;

  // 上下文管理
  assemble(params: { sessionId: string; messages: AgentMessage[]; tokenBudget?: number }): Promise<AssembleResult>;
  compact(params: { sessionId: string; sessionFile: string; tokenBudget?: number; force?: boolean; ... }): Promise<CompactResult>;
  afterTurn?(params: { sessionId: string; sessionFile: string; messages: AgentMessage[]; ... }): Promise<void>;

  // 子代理支持
  prepareSubagentSpawn?(params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;
}
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听模式
npm run build:watch

# 运行测试
npm test

# 测试监听模式
npm run test:watch

# 清理构建产物
npm run clean
```

## 项目结构

```
├── src/
│   ├── index.ts          # 主入口
│   ├── types.ts          # TypeScript 类型定义
│   ├── engine.ts         # ContextEngine 实现
│   ├── plugin.ts         # OpenClaw 插件定义
│   └── engine.test.ts    # 单元测试
├── openclaw.plugin.json  # 插件清单
├── package.json          # NPM 包配置
├── tsconfig.json         # TypeScript 配置
├── vitest.config.ts      # 测试配置
├── README.md             # 英文文档
├── README_CN.md          # 中文文档
└── LICENSE               # MIT 许可证
```

## 系统要求

- OpenClaw >= 2026.3.7
- Node.js >= 18.0.0

## 许可证

MIT © [ye854526102](https://github.com/ye854526102)

## 贡献

欢迎贡献代码！请提交 Pull Request。

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m '添加某个功能'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 相关链接

- [OpenClaw](https://github.com/openclaw/openclaw) - 本插件支持的 AI 代理框架
- [OpenClaw 插件开发文档](https://github.com/openclaw/openclaw/blob/main/docs/tools/plugin.md) - 插件开发指南
- [上下文引擎文档](https://github.com/openclaw/openclaw/blob/main/docs/concepts/context.md) - 上下文管理概念

## 更新日志

### v1.0.0 (2025-03-09)

- 初始版本发布
- 支持智能消息优先级分析（关键、高、普通、低）
- 支持可配置的压缩阈值
- 支持优先关键词保护
- 支持子代理上下文优化
- 包含 26 个单元测试

## 问题反馈

如果遇到问题或有功能建议，请在 [GitHub Issues](https://github.com/ye854526102/openclaw-context-engine-pro/issues) 中提交。
