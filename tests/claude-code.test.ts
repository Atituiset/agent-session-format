import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeClaudeProjectSlug, nirSessionSchema, parseClaudeCodeTranscript } from "../src/index";

const FIXTURE = "tests/fixtures/claude/session.jsonl";

describe("claude-code parser (fixture round-trip)", () => {
  const session = parseClaudeCodeTranscript(readFileSync(FIXTURE, "utf8"), {
    source: "claude-code",
    filePath: FIXTURE,
  });

  it("produces a schema-valid NIR session", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
  });

  it("parses messages and tokens, deduping repeated streaming rows", () => {
    const s = session!;
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/api");
    expect(s.sourceVersion).toBe("2.1.0");
    expect(s.model).toBe("claude-opus-4-7");
    expect(s.startedAt).toBe("2026-05-01T10:00:00.000Z");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const thinking = s.messages.find((m) => m.thinking);
    expect(thinking?.role).toBe("assistant");
    expect(thinking?.content).toBe("");
    expect(thinking?.thinking).toContain("reading the entry file");
    // redacted_thinking blocks produce no message; the duplicate msg_1 row
    // produces no second thinking message either
    expect(s.messages.filter((m) => m.thinking)).toHaveLength(1);
    const editMsg = s.messages.find((m) => m.toolName === "Edit");
    expect(editMsg?.toolInput).toEqual({
      filePath: "/home/u/api/src/app.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(editMsg?.toolCallId).toBe("t1");
    const toolResult = s.messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toBe("applied");
    expect(toolResult?.toolCallId).toBe("t1");
    // msg_1's usage is counted once despite the repeated row; lanes are
    // accounted separately, session.tokens is the grand total
    const assistant = s.messages.find((m) => m.role === "assistant" && m.tokens);
    expect(assistant?.tokens).toEqual({ input: 5000, output: 120, cacheRead: 800, cacheWrite: 0 });
    expect(s.tokens).toEqual({ input: 5100, output: 130, cacheRead: 800, cacheWrite: 0 });
    expect(s.rawMeta.tokensByAgent).toEqual({
      main: { input: 5000, output: 120, cacheRead: 800, cacheWrite: 0 },
      task1: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    });
    const sub = s.messages.find((m) => m.agent === "task1" && m.role === "assistant");
    expect(sub?.tokens).toEqual({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it("lanes sidechain rows under the spawning Task call", () => {
    const s = session!;
    expect(s.rawMeta.sidechainMessages).toBe(2);
    const sidechain = s.messages.filter((m) => m.agent !== null);
    expect(sidechain).toHaveLength(2);
    for (const m of sidechain) {
      expect(m.agent).toBe("task1");
      expect(m.agentLabel).toBe("Explore auth module");
    }
    // main-lane messages stay lane-less
    expect(s.messages[0]?.agent).toBeNull();
    expect(s.messages[0]?.agentLabel).toBeNull();
  });

  it("skips isMeta rows and counts compaction summaries", () => {
    const s = session!;
    expect(s.rawMeta.metaMessages).toBe(1);
    expect(s.rawMeta.compactions).toBe(1);
    expect(s.messages.some((m) => m.content.includes("Caveat:"))).toBe(false);
    const compact = s.messages.find((m) => m.content.includes("continued from a previous conversation"));
    expect(compact?.role).toBe("user");
  });

  it("leaves slugProject null for non-slug directories", () => {
    expect(session!.rawMeta.slugProject).toBeNull();
  });
});

describe("claude-code parser (inline cases)", () => {
  const USER = JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    uuid: "u1",
    timestamp: "2026-01-01T00:00:00Z",
  });

  it("handles single-block (non-array) assistant content", () => {
    const thinking = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: { type: "thinking", thinking: "Let me check..." } },
      timestamp: "2026-01-01T00:00:02Z",
    });
    const toolUse = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "src/auth.ts" } },
      },
      timestamp: "2026-01-01T00:00:03Z",
    });
    const s = parseClaudeCodeTranscript([USER, thinking, toolUse].join("\n"), {
      source: "claude-code",
      id: "s1",
    });
    expect(s).not.toBeNull();
    expect(s!.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(s!.messages[1]?.thinking).toBe("Let me check...");
    expect(s!.messages[2]?.toolName).toBe("Read");
    expect(s!.messages[2]?.toolCallId).toBe("toolu_01");
  });

  it("captures ai-title rows as the session title", () => {
    const title = JSON.stringify({ type: "ai-title", aiTitle: "My Session" });
    const s = parseClaudeCodeTranscript([title, USER].join("\n"), { source: "claude-code", id: "s1" });
    expect(s!.title).toBe("My Session");
  });

  it("falls back to summary rows for the title, ai-title wins", () => {
    const summary = JSON.stringify({ type: "summary", summary: "Fix login bug", leafUuid: "x" });
    const s = parseClaudeCodeTranscript([summary, USER].join("\n"), { source: "claude-code", id: "s1" });
    expect(s!.title).toBe("Fix login bug");
    const titled = JSON.stringify({ type: "ai-title", aiTitle: "Better" });
    const s2 = parseClaudeCodeTranscript([summary, titled, USER].join("\n"), {
      source: "claude-code",
      id: "s1",
    });
    expect(s2!.title).toBe("Better");
  });

  it("pairs tool_result content blocks carried in user rows", () => {
    const toolResult = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: { type: "tool_result", tool_use_id: "toolu_01", content: "export const auth = ..." },
      },
      timestamp: "2026-01-01T00:00:04Z",
    });
    const s = parseClaudeCodeTranscript([USER, toolResult].join("\n"), { source: "claude-code", id: "s1" });
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages[1]).toMatchObject({ role: "tool", content: "export const auth = ...", toolCallId: "toolu_01" });
  });

  it("never truncates tool results", () => {
    const big = "x".repeat(50_000);
    const toolResult = JSON.stringify({
      type: "user",
      message: { role: "user", content: { type: "tool_result", tool_use_id: "toolu_01", content: big } },
      timestamp: "2026-01-01T00:00:04Z",
    });
    const s = parseClaudeCodeTranscript([USER, toolResult].join("\n"), { source: "claude-code", id: "s1" });
    expect(s!.messages[1]?.content).toHaveLength(50_000);
  });

  it("counts usage once per message.id across streaming retries", () => {
    const row = (uuid: string, ts: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_x",
          content: [{ type: "text", text: "partial answer" }],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
        uuid,
        timestamp: ts,
      });
    const s = parseClaudeCodeTranscript([USER, row("a1", "2026-01-01T00:00:01Z"), row("a2", "2026-01-01T00:00:02Z")].join("\n"), {
      source: "claude-code",
      id: "s1",
    });
    expect(s!.tokens).toEqual({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(s!.messages.filter((m) => m.content === "partial answer")).toHaveLength(1);
  });

  it("falls back to a root-uuid lane when the spawning Task call is unresolvable", () => {
    const orphan = JSON.stringify({
      type: "user",
      message: { role: "user", content: "orphaned sidechain row" },
      uuid: "s9",
      parentUuid: "missing",
      isSidechain: true,
      timestamp: "2026-01-01T00:00:05Z",
    });
    const s = parseClaudeCodeTranscript([USER, orphan].join("\n"), { source: "claude-code", id: "s1" });
    const laneMsg = s!.messages.find((m) => m.content === "orphaned sidechain row");
    expect(laneMsg?.agent).toBe("sidechain-s9");
    expect(laneMsg?.agentLabel).toBeNull();
    expect(s!.rawMeta.sidechainMessages).toBe(1);
  });

  it("applies opts.agent/agentLabel to every message (subagent file mode)", () => {
    const s = parseClaudeCodeTranscript(USER, {
      source: "claude-code",
      id: "s1",
      agent: "agent-0",
      agentLabel: "explore · agent-0",
    });
    expect(s!.messages[0]?.agent).toBe("agent-0");
    expect(s!.messages[0]?.agentLabel).toBe("explore · agent-0");
  });

  it("returns null when nothing parses", () => {
    expect(parseClaudeCodeTranscript("garbage\n{}\n", { source: "claude-code", id: "s1" })).toBeNull();
  });
});

describe("decodeClaudeProjectSlug", () => {
  it("decodes known root prefixes", () => {
    expect(decodeClaudeProjectSlug("/home/u/.claude/projects/-home-me-my-project/s.jsonl")).toBe(
      "/me/my/project",
    );
    expect(decodeClaudeProjectSlug("/home/u/.claude/projects/-Users-me-app/s.jsonl")).toBe("/me/app");
  });
  it("returns null for ambiguous slugs", () => {
    expect(decodeClaudeProjectSlug("/home/u/.claude/projects/-opt-my-app/s.jsonl")).toBeNull();
    expect(decodeClaudeProjectSlug("tests/fixtures/claude/session.jsonl")).toBeNull();
  });
});
