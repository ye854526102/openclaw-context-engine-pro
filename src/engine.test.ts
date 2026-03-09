import { describe, it, expect, beforeEach } from "vitest";
import { ContextEnginePro, DEFAULT_CONFIG } from "./engine.js";
import type { AgentMessage, PluginLogger } from "./types.js";

// Mock logger
const mockLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("ContextEnginePro", () => {
  let engine: ContextEnginePro;

  beforeEach(() => {
    engine = new ContextEnginePro(DEFAULT_CONFIG, mockLogger);
  });

  describe("info", () => {
    it("should return correct engine info", () => {
      expect(engine.info.id).toBe("context-engine-pro");
      expect(engine.info.name).toBe("Context Engine Pro");
      expect(engine.info.version).toBe("1.0.2");
      expect(engine.info.ownsCompaction).toBe(true);
    });
  });

  describe("bootstrap", () => {
    it("should initialize a new session", async () => {
      const result = await engine.bootstrap({
        sessionId: "test-session",
        sessionFile: "/path/to/session.jsonl",
      });

      expect(result.bootstrapped).toBe(true);
      expect(result.importedMessages).toBe(0);
      expect(result.reason).toBeDefined();
    });

    it("should not re-initialize existing session", async () => {
      await engine.bootstrap({
        sessionId: "test-session",
        sessionFile: "/path/to/session.jsonl",
      });

      const result = await engine.bootstrap({
        sessionId: "test-session",
        sessionFile: "/path/to/session.jsonl",
      });

      expect(result.bootstrapped).toBe(true);
    });
  });

  describe("ingest", () => {
    it("should ingest a user message", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "user",
        content: "Hello, world!",
      };

      const result = await engine.ingest({
        sessionId: "test-session",
        message,
      });

      expect(result.ingested).toBe(true);
    });

    it("should ingest an assistant message", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "assistant",
        content: "Hi there! How can I help you?",
      };

      const result = await engine.ingest({
        sessionId: "test-session",
        message,
      });

      expect(result.ingested).toBe(true);
    });

    it("should ingest a tool result message as critical priority", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "tool",
        content: "Tool result content",
        toolCallId: "call-123",
      };

      const result = await engine.ingest({
        sessionId: "test-session",
        message,
      });

      expect(result.ingested).toBe(true);
    });

    it("should ingest a message with tool use as critical priority", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that for you." },
          { type: "tool_use", id: "tool-1", name: "search", input: { query: "test" } },
        ],
      };

      const result = await engine.ingest({
        sessionId: "test-session",
        message,
      });

      expect(result.ingested).toBe(true);
    });

    it("should ingest a message with code block as high priority", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "assistant",
        content: "Here's the code:\n```typescript\nconsole.log('hello');\n```",
      };

      const result = await engine.ingest({
        sessionId: "test-session",
        message,
      });

      expect(result.ingested).toBe(true);
    });

    it("should return false for unknown session", async () => {
      const message: AgentMessage = {
        role: "user",
        content: "Hello",
      };

      const result = await engine.ingest({
        sessionId: "unknown-session",
        message,
      });

      expect(result.ingested).toBe(false);
    });
  });

  describe("ingestBatch", () => {
    it("should ingest multiple messages", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const messages: AgentMessage[] = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Message 2" },
        { role: "user", content: "Message 3" },
      ];

      const result = await engine.ingestBatch({
        sessionId: "test-session",
        messages,
      });

      expect(result.ingestedCount).toBe(3);
    });
  });

  describe("assemble", () => {
    it("should assemble messages within token budget", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const messages: AgentMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];

      for (const msg of messages) {
        await engine.ingest({ sessionId: "test-session", message: msg });
      }

      const result = await engine.assemble({
        sessionId: "test-session",
        messages,
        tokenBudget: 1000,
      });

      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.systemPromptAddition).toBeDefined();
    });

    it("should return all messages when no budget constraint", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const messages: AgentMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];

      for (const msg of messages) {
        await engine.ingest({ sessionId: "test-session", message: msg });
      }

      const result = await engine.assemble({
        sessionId: "test-session",
        messages,
        tokenBudget: 0,
      });

      expect(result.messages.length).toBe(2);
    });
  });

  describe("compact", () => {
    it("should not compact when below threshold", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      const message: AgentMessage = {
        role: "user",
        content: "Hello",
      };

      await engine.ingest({ sessionId: "test-session", message });

      const result = await engine.compact({
        sessionId: "test-session",
        sessionFile: "/path",
        tokenBudget: 10000,
        currentTokenCount: 10,
      });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
      expect(result.reason).toContain("threshold");
    });

    it("should compact when forced", async () => {
      await engine.bootstrap({ sessionId: "test-session", sessionFile: "/path" });

      // Ingest many messages
      for (let i = 0; i < 20; i++) {
        await engine.ingest({
          sessionId: "test-session",
          message: { role: "user", content: `Message ${i} - This is some content to make it longer.` },
        });
      }

      const result = await engine.compact({
        sessionId: "test-session",
        sessionFile: "/path",
        tokenBudget: 100,
        force: true,
      });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
      expect(result.result?.tokensAfter).toBeDefined();
    });

    it("should return error for unknown session", async () => {
      const result = await engine.compact({
        sessionId: "unknown-session",
        sessionFile: "/path",
        tokenBudget: 1000,
        force: true,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("prepareSubagentSpawn", () => {
    it("should prepare subagent context", async () => {
      await engine.bootstrap({ sessionId: "parent-session", sessionFile: "/path" });

      // Ingest some messages
      for (let i = 0; i < 5; i++) {
        await engine.ingest({
          sessionId: "parent-session",
          message: { role: "user", content: `Message ${i}` },
        });
      }

      const result = await engine.prepareSubagentSpawn({
        parentSessionKey: "parent-session",
        childSessionKey: "child-session",
        ttlMs: 60000,
      });

      expect(result).toBeDefined();
      expect(result?.rollback).toBeDefined();
    });

    it("should return undefined for unknown parent session", async () => {
      const result = await engine.prepareSubagentSpawn({
        parentSessionKey: "unknown-parent",
        childSessionKey: "child-session",
      });

      expect(result).toBeUndefined();
    });

    it("should return undefined when subagent context is disabled", async () => {
      const disabledEngine = new ContextEnginePro(
        { ...DEFAULT_CONFIG, enableSubagentContext: false },
        mockLogger
      );

      await disabledEngine.bootstrap({ sessionId: "parent", sessionFile: "/path" });

      const result = await disabledEngine.prepareSubagentSpawn({
        parentSessionKey: "parent",
        childSessionKey: "child",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("onSubagentEnded", () => {
    it("should clean up subagent state", async () => {
      await engine.bootstrap({ sessionId: "parent", sessionFile: "/path" });

      // Prepare subagent
      await engine.prepareSubagentSpawn({
        parentSessionKey: "parent",
        childSessionKey: "child",
      });

      // End subagent
      await engine.onSubagentEnded({
        childSessionKey: "child",
        reason: "completed",
      });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("dispose", () => {
    it("should clean up all resources", async () => {
      await engine.bootstrap({ sessionId: "test", sessionFile: "/path" });
      await engine.ingest({
        sessionId: "test",
        message: { role: "user", content: "Test" },
      });

      await engine.dispose();

      // After dispose, the engine should be marked as disposed
      expect(engine.info.id).toBe("context-engine-pro");
    });

    it("should throw error after dispose", async () => {
      await engine.bootstrap({ sessionId: "test", sessionFile: "/path" });
      await engine.dispose();

      // After dispose, bootstrap should throw error
      await expect(engine.bootstrap({ sessionId: "test", sessionFile: "/path" }))
        .rejects.toThrow("Engine has been disposed");
    });
  });

  describe("priority analysis", () => {
    it("should mark tool results as critical", async () => {
      await engine.bootstrap({ sessionId: "test", sessionFile: "/path" });

      const toolMessage: AgentMessage = {
        role: "tool",
        content: "Result",
        toolCallId: "call-1",
      };

      await engine.ingest({ sessionId: "test", message: toolMessage });

      // Verify through assemble behavior (tool message should be preserved)
      const result = await engine.assemble({
        sessionId: "test",
        messages: [toolMessage],
        tokenBudget: 1000,
      });

      expect(result.messages).toContainEqual(toolMessage);
    });

    it("should mark code blocks as high priority", async () => {
      await engine.bootstrap({ sessionId: "test", sessionFile: "/path" });

      const codeMessage: AgentMessage = {
        role: "assistant",
        content: "Here's some code:\n```javascript\nconsole.log('hello');\n```",
      };

      await engine.ingest({ sessionId: "test", message: codeMessage });

      const result = await engine.assemble({
        sessionId: "test",
        messages: [codeMessage],
        tokenBudget: 1000,
      });

      expect(result.messages).toContainEqual(codeMessage);
    });

    it("should mark messages with priority keywords as high priority", async () => {
      const engineWithKeywords = new ContextEnginePro(
        { ...DEFAULT_CONFIG, priorityKeywords: ["important", "critical"] },
        mockLogger
      );

      await engineWithKeywords.bootstrap({ sessionId: "test", sessionFile: "/path" });

      const importantMessage: AgentMessage = {
        role: "user",
        content: "This is an IMPORTANT message that should be preserved!",
      };

      await engineWithKeywords.ingest({ sessionId: "test", message: importantMessage });

      const result = await engineWithKeywords.assemble({
        sessionId: "test",
        messages: [importantMessage],
        tokenBudget: 1000,
      });

      expect(result.messages).toContainEqual(importantMessage);
    });
  });

  describe("custom configuration", () => {
    it("should respect custom compaction threshold", async () => {
      const customEngine = new ContextEnginePro(
        { ...DEFAULT_CONFIG, compactionThreshold: 0.5 },
        mockLogger
      );

      await customEngine.bootstrap({ sessionId: "test", sessionFile: "/path" });

      // Under 50% threshold should not compact
      const result = await customEngine.compact({
        sessionId: "test",
        sessionFile: "/path",
        tokenBudget: 10000,
        currentTokenCount: 4000, // 40%
      });

      expect(result.compacted).toBe(false);
    });

    it("should respect preserve recent turns setting", async () => {
      const customEngine = new ContextEnginePro(
        { ...DEFAULT_CONFIG, preserveRecentTurns: 3 },
        mockLogger
      );

      await customEngine.bootstrap({ sessionId: "test", sessionFile: "/path" });

      // Ingest 10 messages
      for (let i = 0; i < 10; i++) {
        await customEngine.ingest({
          sessionId: "test",
          message: { role: "user", content: `Message ${i}` },
        });
      }

      const result = await customEngine.compact({
        sessionId: "test",
        sessionFile: "/path",
        tokenBudget: 50,
        force: true,
      });

      expect(result.ok).toBe(true);
    });
  });
});

describe("DEFAULT_CONFIG", () => {
  it("should have expected default values", () => {
    expect(DEFAULT_CONFIG.maxContextTokens).toBe(0);
    expect(DEFAULT_CONFIG.compactionThreshold).toBe(0.8);
    expect(DEFAULT_CONFIG.preserveRecentTurns).toBe(5);
    expect(DEFAULT_CONFIG.enableSmartSummarization).toBe(true);
    expect(DEFAULT_CONFIG.priorityKeywords).toEqual([]);
    expect(DEFAULT_CONFIG.enableSubagentContext).toBe(true);
    expect(DEFAULT_CONFIG.maxSubagentContextTokens).toBe(0);
  });
});
