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

  it("parses messages, tokens, sidechain skip", () => {
    const s = session!;
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/api");
    expect(s.sourceVersion).toBe("2.1.0");
    expect(s.model).toBe("claude-opus-4-7");
    expect(s.startedAt).toBe("2026-05-01T10:00:00.000Z");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant", "tool"]);
    const thinking = s.messages.find((m) => m.thinking);
    expect(thinking?.role).toBe("assistant");
    expect(thinking?.content).toBe("");
    expect(thinking?.thinking).toContain("reading the entry file");
    // redacted_thinking blocks produce no message
    expect(s.messages.filter((m) => m.thinking)).toHaveLength(1);
    expect(s.rawMeta.sidechainMessages).toBe(1);
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
    const assistant = s.messages.find((m) => m.role === "assistant" && m.tokens);
    expect(assistant?.tokens).toEqual({ input: 5000, output: 120, cacheRead: 800, cacheWrite: 0 });
    expect(s.tokens).toEqual({ input: 5000, output: 120, cacheRead: 800, cacheWrite: 0 });
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
