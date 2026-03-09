# Context Engine Pro - 深度审查报告

## 1. 发现的潜在 Bug

### 🔴 严重问题

#### 1.1 消息 ID 生成不稳定 (engine.ts:422-426)

```typescript
private generateMessageId(message: AgentMessage): string {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const hash = this.simpleHash(content);
  return `${message.role}-${hash}-${Date.now()}`;  // ❌ 问题：每次调用都会生成不同的 ID
}
```

**问题**：
- `Date.now()` 导致同一消息多次调用生成不同 ID
- 在 `prioritizeMessages()` 中无法匹配已存储的 meta
- 导致 `assemble()` 和 `compact()` 无法正确识别消息优先级

**影响**：压缩时无法正确识别关键消息，可能导致重要消息被误删

**修复方案**：
```typescript
private generateMessageId(message: AgentMessage): string {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const hash = this.simpleHash(content + message.role);
  return `${message.role}-${hash}`;
}
```

---

#### 1.2 消息去重缺失 (engine.ts:168-169)

```typescript
store.messages.push(message);
store.meta.set(messageId, meta);
```

**问题**：
- 没有检查重复消息
- `ingest()` 和 `ingestBatch()` 可能重复添加同一消息
- 导致 token 计数翻倍

**修复方案**：
```typescript
// 检查重复
if (store.meta.has(messageId)) {
  this.logger.debug?.(`[context-engine-pro] Duplicate message skipped: ${messageId}`);
  return { ingested: false };
}
```

---

#### 1.3 compact() 没有真正减少消息数量

**问题**：`compact()` 只更新了内部 `sessionStores`，但：
- OpenClaw 的 `compact()` 需要返回修改后的消息列表
- `LegacyContextEngine` 调用 `compactEmbeddedPiSessionDirect` 真正执行压缩
- 我们的实现没有修改传入的 `messages` 参数

**影响**：压缩无效，消息不会真正减少

---

### 🟡 中等问题

#### 2.1 sessionFile 未使用 (engine.ts:116)

```typescript
async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
  const { sessionId } = params;  // sessionFile 被忽略
```

**问题**：`sessionFile` 参数被忽略，无法从历史文件恢复上下文

---

#### 2.2 内存泄漏风险

```typescript
private sessionStores: Map<string, { messages: AgentMessage[]; meta: Map<string, MessageMeta> }>;
```

**问题**：
- 会话结束后没有清理 `sessionStores`
- 长时间运行会内存溢出
- 需要 `onSubagentEnded` 中清理或添加会话过期机制

---

#### 2.3 assemble() 返回顺序错误 (engine.ts:267-277)

```typescript
for (const { message, tokens } of prioritized) {
  if (currentTokens + tokens <= effectiveBudget) {
    selected.push(message);
    currentTokens += tokens;
  } else {
    break;  // ❌ 问题：按优先级排序后插入，破坏了消息的时间顺序
  }
}
```

**问题**：消息按优先级排序后插入，破坏了对话的时间顺序，可能导致上下文不连贯

---

#### 2.4 hasToolResult() 检查不完整 (engine.ts:471-480)

```typescript
private hasToolResult(message: AgentMessage): boolean {
  if (message.role === "tool") return true;

  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content.some(
      (block) => block.type === "tool_use" || block.type === "tool_result"
    );
  }
  return false;
}
```

**问题**：
- `tool_result` 类型应该是 `tool` role，不应该在 `assistant` 消息中
- 漏掉了检查 `block.type === "tool_use"` 时的 `input` 内容重要性

---

#### 2.5 hasCodeBlock() 检测过于简单 (engine.ts:486-489)

```typescript
private hasCodeBlock(message: AgentMessage): boolean {
  const content = typeof message.content === "string" ? message.content : "";
  return content.includes("```") || content.includes("<code>");
}
```

**问题**：
- 只检查字符串内容
- 数组类型的 content（如包含 `text` block）不会被正确处理
- 可能漏掉代码块

---

### 🟢 轻微问题

#### 3.1 Token 估算不准确

```typescript
private estimateTokens(message: AgentMessage): number {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return Math.ceil(content.length / 4);
}
```

**问题**：
- 简单的 `length / 4` 对中文等非拉丁字符不准确
- 没有考虑消息元数据（role、name 等）的 token
- 应该使用更精确的估算方法

---

#### 3.2 配置验证缺失

**问题**：没有验证配置参数的合法性：
- `compactionThreshold` 可以超过 1 或小于 0
- `preserveRecentTurns` 可以是负数
- `maxContextTokens` 可以是负数

---

## 2. 与 OpenClaw 源码的对比

### LegacyContextEngine 对比

| 功能 | LegacyContextEngine | ContextEnginePro | 差异 |
|------|---------------------|------------------|------|
| `ingest` | no-op，返回 `{ingested: false}` | 完整实现 | ✅ 我们更完整 |
| `assemble` | 直接返回 messages | 按预算裁剪 | ⚠️ 需要测试兼容性 |
| `compact` | 调用核心压缩函数 | 自己实现 | ⚠️ 可能与核心逻辑不一致 |
| `afterTurn` | no-op | 监控阈值 | ✅ 我们更完整 |

### 关键发现

1. **LegacyContextEngine 的 `ingest` 是 no-op**，因为 SessionManager 已经处理了消息持久化。我们的实现可能与核心逻辑冲突。

2. **LegacyContextEngine 的 `assemble` 直接返回消息**，实际的上下文组装由 `attempt.ts` 中的 `sanitize -> validate -> limit -> repair` 管道处理。我们的裁剪可能重复或冲突。

3. **LegacyContextEngine 的 `compact` 调用 `compactEmbeddedPiSessionDirect`**，这是真正的压缩实现。我们的实现可能绕过了核心逻辑。

---

## 3. 优化建议

### 立即修复 (P0)

1. **修复消息 ID 生成** - 移除 `Date.now()`
2. **添加消息去重** - 在 `ingest()` 中检查重复
3. **保持消息顺序** - `assemble()` 不应改变时间顺序
4. **添加会话清理** - 防止内存泄漏

### 短期优化 (P1)

5. **改进 token 估算** - 使用更准确的方法
6. **添加配置验证** - 在构造函数中验证参数
7. **处理数组类型 content** - 修复 `hasCodeBlock()` 等方法
8. **实现会话恢复** - 使用 `sessionFile` 参数

### 长期规划 (P2)

9. **持久化存储** - 支持会话数据持久化
10. **智能摘要** - 使用 LLM 生成真正的摘要
11. **向量化检索** - 基于语义相似度选择消息
12. **配置热更新** - 运行时修改配置

---

## 4. 未来版本功能规划

### v1.1.0 - 稳定性修复

- [ ] 修复所有 P0 级别 Bug
- [ ] 添加单元测试覆盖边界条件
- [ ] 改进 token 估算精度
- [ ] 添加配置验证

### v1.2.0 - 功能增强

- [ ] 会话持久化和恢复
- [ ] 更好的代码块检测（支持数组 content）
- [ ] 时间窗口压缩策略
- [ ] 配置热更新支持

### v2.0.0 - 智能化

- [ ] LLM 摘要集成
- [ ] 语义相似度检索
- [ ] 自适应压缩策略
- [ ] 多策略支持（用户可切换）

---

## 5. 建议的代码修复

### 修复 1: 稳定的消息 ID 生成

```typescript
private generateMessageId(message: AgentMessage): string {
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
  const hash = this.simpleHash(`${message.role}:${content}`);
  return `${message.role}-${hash}`;
}
```

### 修复 2: 消息去重

```typescript
async ingest(params: { ... }): Promise<IngestResult> {
  const { sessionId, message } = params;
  const store = this.sessionStores.get(sessionId);
  if (!store) {
    this.logger.warn(`[context-engine-pro] Session not found: ${sessionId}`);
    return { ingested: false };
  }

  const messageId = this.generateMessageId(message);

  // 去重检查
  if (store.meta.has(messageId)) {
    this.logger.debug?.(`[context-engine-pro] Duplicate message skipped: ${messageId}`);
    return { ingested: false };
  }

  // ... 继续处理
}
```

### 修复 3: 保持消息顺序

```typescript
async assemble(params: { ... }): Promise<AssembleResult> {
  // ... 省略前面代码

  // 方案：标记优先级但保持原始顺序
  const messagePriority = new Map<string, MessagePriority>();
  for (const message of messages) {
    const msgId = this.generateMessageId(message);
    const meta = store?.meta.get(msgId);
    messagePriority.set(msgId, meta?.priority || this.analyzeMessagePriority(message));
  }

  // 按原始顺序选择，但优先跳过低优先级消息
  // ... 实现细节
}
```

### 修复 4: 会话清理

```typescript
private sessionTTL: number = 3600000; // 1 小时
private lastAccessTime: Map<string, number> = new Map();

// 在每个方法中更新访问时间
async ingest(params: { ... }): Promise<IngestResult> {
  this.lastAccessTime.set(params.sessionId, Date.now());
  // ...
}

// 定期清理过期会话
private startCleanupTimer(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastAccess] of this.lastAccessTime) {
      if (now - lastAccess > this.sessionTTL) {
        this.sessionStores.delete(sessionId);
        this.lastAccessTime.delete(sessionId);
        this.logger.info(`[context-engine-pro] Cleaned up expired session: ${sessionId}`);
      }
    }
  }, 60000); // 每分钟检查一次
}
```

---

## 6. 测试建议

需要添加的测试用例：

1. **重复消息测试** - 验证去重逻辑
2. **大消息测试** - 验证 token 估算边界
3. **空消息测试** - 验证边界条件处理
4. **并发测试** - 验证多会话并发安全
5. **内存泄漏测试** - 验证会话清理
6. **消息顺序测试** - 验证 assemble 保持时间顺序
7. **配置边界测试** - 验证非法配置处理
