import { describe, expect, it } from "vitest";
import { detectKind, nirSessionSchema, parseChatTranscript, parseDetectedTranscript } from "../src/index";

describe("detectKind content classification", () => {
  it("detects claude-style event streams", () => {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x" } });
    expect(detectKind(line)).toBe("claude-style");
  });

  it("detects codex-style rollouts", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } });
    expect(detectKind(line)).toBe("codex-style");
  });

  it("detects chat-style dumps", () => {
    expect(detectKind(JSON.stringify({ role: "user", content: "hello" }))).toBe("chat-style");
  });

  it("detects session-style single-file JSON", () => {
    const whole = JSON.stringify({
      schema_version: 1,
      metadata: { id: "a", title: "T", created_at: "2026-07-01T00:00:00Z" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(detectKind(whole)).toBe("session-style");
  });

  it("detects session-style from a truncated fragment (readHead cut mid-JSON)", () => {
    const big = JSON.stringify({
      schema_version: 1,
      metadata: { id: "a", title: "T" },
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(8000) }] }],
    }).slice(0, 4096);
    expect(detectKind(big)).toBe("session-style");
  });

  it("does not misfire on config files or non-message shapes", () => {
    expect(detectKind(JSON.stringify({ version: 1, settings: { a: 1 } }))).toBeNull();
    expect(detectKind(JSON.stringify({ messages: ["plain"] }))).toBeNull();
    expect(detectKind('{"foo":1}')).toBeNull();
    expect(detectKind("not json")).toBeNull();
  });

  it("skips corrupt leading lines and classifies the first parseable one", () => {
    const sample = [
      "garbage",
      JSON.stringify({ type: "user", message: { role: "user", content: "build it" } }),
    ].join("\n");
    expect(detectKind(sample)).toBe("claude-style");
  });
});

describe("parseChatTranscript", () => {
  it("parses line by line, tolerating bad rows", () => {
    const content = [
      JSON.stringify({ role: "user", content: "q", timestamp: "2026-09-01T00:00:00Z" }),
      JSON.stringify({ role: "assistant", content: "a", timestamp: "2026-09-01T00:01:00Z" }),
      "bad line {",
      JSON.stringify({ role: "tool", content: "tool output" }),
    ].join("\n");
    const s = parseChatTranscript(content, { source: "generic", id: "conv-1" })!;
    expect(nirSessionSchema.safeParse(s).success).toBe(true);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(s.messages[0]?.timestamp).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns null when nothing parses", () => {
    expect(parseChatTranscript("garbage\n", { source: "generic", id: "x" })).toBeNull();
  });
});

describe("parseDetectedTranscript dispatch", () => {
  it("routes each kind to its family parser", () => {
    const claude = parseDetectedTranscript(
      "claude-style",
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-09-01T00:00:00Z" }),
      { source: "generic", id: "s" },
    );
    expect(claude!.messages[0]?.role).toBe("user");

    const codex = parseDetectedTranscript(
      "codex-style",
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
      { source: "generic", id: "s" },
    );
    expect(codex!.messages[0]?.content).toBe("hi");

    const chat = parseDetectedTranscript("chat-style", JSON.stringify({ role: "user", content: "q" }), {
      source: "generic",
      id: "s",
    });
    expect(chat!.messages[0]?.role).toBe("user");

    const session = parseDetectedTranscript(
      "session-style",
      JSON.stringify({
        metadata: { created_at: "2026-09-01T00:00:00Z" },
        messages: [
          { role: "user", content: "看下 README" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先读文件" },
              { type: "tool_use", id: "tu1", name: "read_file", input: { path: "README.md" } },
            ],
          },
        ],
      }),
      { source: "generic", id: "1111" },
    );
    expect(session).not.toBeNull();
    expect(session!.messages.some((m) => m.toolName === "read_file")).toBe(true);
  });
});
