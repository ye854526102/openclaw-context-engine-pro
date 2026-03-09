# 生产环境深度检查报告

## 🔴 严重风险

### 1. 消息 ID 碰撞风险 (engine.ts:584-600)

```typescript
private simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
```

**问题**：
- 32位哈希碰撞概率高（约 1/2^32 对于随机数据，但实际更糟）
- 两条不同消息可能生成相同 ID，导致：
  - 后一条消息被误判为重复
  - **静默数据丢失** - 用户消息莫名其妙消失

**修复**：使用更强的哈希算法（SHA-256 或更长 ID）

---

### 2. JSON.stringify 不稳定 (engine.ts:585)

```typescript
const content = typeof message.content === "string"
  ? message.content
  : JSON.stringify(message.content);
```

**问题**：
- `{a:1,b:2}` 和 `{b:2,a:1}` 生成不同字符串但语义相同
- 循环引用会抛出 `TypeError: Converting circular structure to JSON`
- `undefined` 在数组中会变成 `null`

**生产影响**：崩溃或 ID 不一致

---

### 3. 无错误边界保护

所有 async 方法都没有 try-catch：
- `ingest()` - 消息处理失败会中断整个流程
- `assemble()` - 上下文组装失败导致请求崩溃
- `compact()` - 压缩失败可能导致服务不可用

**生产影响**：单条异常消息可能导致整个服务崩溃

---

### 4. 并发竞态条件

```typescript
// bootstrap() 没有锁保护
if (!this.sessionStores.has(sessionId)) {
  this.sessionStores.set(sessionId, {...});
}
```

**问题**：
- 两个并发请求同时调用 `bootstrap()` 可能创建重复 store
- `ingest()` 和 `compact()` 并发调用可能导致数据不一致

---

### 5. 无界内存增长

- `sessionStores` 无大小限制
- `messageIndex` 永不重置
- 单个会话可以无限增长
- 清理 timer 仅基于 TTL，不考虑大小

**生产影响**：内存溢出（OOM）

---

## 🟡 中等风险

### 6. assemble() 与 store 不同步

```typescript
async assemble(params: { messages: AgentMessage[]; ... }) {
  // 使用传入的 messages，但 priority 从 store 查找
  const meta = store?.meta.get(msgId);
}
```

**问题**：
- OpenClaw 可能传入与 store 中不同的消息列表
- 导致优先级查找失败，回退到实时分析
- 性能下降 + 行为不一致

---

### 7. 空值检查缺失

```typescript
// message.content 可能是 null 或 undefined
const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
```

**问题**：
- `null` 不是 string，会尝试 `JSON.stringify(null)` → `"null"`
- 但语义上是空消息，应该特殊处理

---

### 8. 清理 Timer 泄漏风险

```typescript
private startCleanupTimer(): void {
  this.cleanupTimer = setInterval(() => {...}, 60000);
}
```

**问题**：
- 如果 `dispose()` 抛异常，timer 继续运行
- 多次创建 engine 实例会创建多个 timer
- Node.js 进程无法正常退出（timer 阻止退出）

---

### 9. Token 估算边界问题

```typescript
// 空消息
if (!content || content.length === 0) {
  return 10; // 只加了 overhead
}
```

**问题**：
- 空消息估算不准确
- 超大消息（如代码文件）会导致性能问题

---

## 🟢 低风险但需注意

### 10. 未使用的 sessionFile 参数

```typescript
async bootstrap(params: { sessionId: string; sessionFile: string }) {
  // sessionFile 被完全忽略
}
```

**影响**：无法从历史会话恢复

---

### 11. 日志敏感信息泄露

```typescript
this.logger.debug?.(`[context-engine-pro] Duplicate message skipped: ${messageId}`);
```

**问题**：messageId 包含内容哈希，可能泄露信息

---

### 12. 类型不够严格

```typescript
type AgentMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentBlock[];
  // 缺少可选字段的类型保护
};
```

---

## 建议修复优先级

| 优先级 | 问题 | 修复建议 |
|--------|------|----------|
| P0 | ID 碰撞 | 使用更长 ID + 内容前缀 |
| P0 | 错误边界 | 所有 async 方法加 try-catch |
| P0 | 并发安全 | 添加锁机制或幂等性保护 |
| P1 | 内存限制 | 添加会话消息上限 |
| P1 | JSON.stringify | 添加安全序列化 |
| P2 | Timer 管理 | 添加 ref/unref 管理 |
| P2 | 空值检查 | 添加 defensive 编程 |

---

## 测试覆盖缺失

需要添加的测试场景：

1. **边界条件**
   - 空消息
   - 超大消息（>1MB）
   - 特殊字符（emoji、控制字符）
   - 循环引用对象

2. **并发场景**
   - 多会话并发 bootstrap
   - 并发 ingest + compact
   - 高频消息流

3. **压力测试**
   - 10000+ 消息会话
   - 100+ 并发会话
   - 长时间运行（内存泄漏检测）

4. **错误恢复**
   - 无效消息格式
   - 部分失败恢复
   - dispose 后重新使用

---

## 监控建议

生产环境应监控：

1. **性能指标**
   - ingest 延迟
   - assemble 延迟
   - compact 耗时
   - 内存使用

2. **业务指标**
   - 活跃会话数
   - 消息总数
   - 压缩触发频率
   - ID 碰撞次数

3. **错误追踪**
   - 消息处理失败率
   - 异常类型分布
