import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nirSessionSchema,
  parseCodexRollout,
  parseCodewhaleSession,
  parseKimiWire,
} from "../src/index";

describe("codex rollout (fixture round-trip)", () => {
  const session = parseCodexRollout(readFileSync("tests/fixtures/codex/rollout.jsonl", "utf8"), {
    source: "codex",
    filePath: "tests/fixtures/codex/rollout.jsonl",
  });

  it("produces a schema-valid NIR session", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
  });

  it("parses meta, messages, tools, reasoning, patch files", () => {
    const s = session!;
    expect(s.id).toBe("019d5918-test");
    expect(s.projectPath).toBe("/home/u/proj");
    expect(s.sourceVersion).toBe("0.118.0");
    expect(s.model).toBe("gpt-5.1-codex");
    const roles = s.messages.map((m) => m.role);
    expect(roles.filter((x) => x === "user")).toHaveLength(1);
    expect(roles.filter((x) => x === "assistant")).toHaveLength(4);
    expect(roles.filter((x) => x === "tool")).toHaveLength(1);
    const thinking = s.messages.find((m) => m.thinking);
    expect(thinking?.role).toBe("assistant");
    expect(thinking?.content).toBe("");
    expect(thinking?.thinking).toContain("missing null check");
    const toolMsg = s.messages.find((m) => m.toolName === "exec_command");
    expect(toolMsg?.toolInput).toEqual({ cmd: "rg login src" });
    expect(toolMsg?.toolCallId).toBe("call_01");
    const toolOut = s.messages.find((m) => m.role === "tool");
    expect(toolOut?.toolCallId).toBe("call_01");
    expect(toolOut?.toolName).toBe("exec_command");
    expect(s.rawMeta.patchFiles).toEqual(["src/auth.ts"]);
    const lastAssistant = s.messages.filter((m) => m.role === "assistant").at(-1);
    expect(lastAssistant?.content).toContain("Fixed the login");
  });
});

describe("codex rollout (inline cases)", () => {
  const item = (payload: unknown, timestamp = "2026-01-01T00:00:00Z") =>
    JSON.stringify({ timestamp, type: "response_item", payload });

  it("pairs function_call_output by call_id and parses reasoning summaries", () => {
    const lines = [
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }),
      item(
        { type: "reasoning", summary: [{ type: "summary_text", text: "need to inspect the dir" }], encrypted_content: "abc" },
        "2026-01-01T00:00:01Z",
      ),
      item(
        { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }), call_id: "call_1" },
        "2026-01-01T00:00:02Z",
      ),
      item({ type: "function_call_output", call_id: "call_1", output: "total 8\nfile.txt" }, "2026-01-01T00:00:03Z"),
      item(
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "here are the files" }] },
        "2026-01-01T00:00:04Z",
      ),
    ];
    const s = parseCodexRollout(lines.join("\n"), { source: "codex", id: "r1" })!;
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
    expect(s.messages[1]?.thinking).toBe("need to inspect the dir");
    expect(s.messages[3]?.content).toBe("total 8\nfile.txt");
  });

  it("handles custom_tool_call apply_patch with raw string input", () => {
    const lines = [
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "patch it" }] }),
      item({
        type: "custom_tool_call",
        status: "completed",
        call_id: "call_p",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch",
      }),
      item({ type: "custom_tool_call_output", call_id: "call_p", output: "Success. Updated a.ts" }),
    ];
    const s = parseCodexRollout(lines.join("\n"), { source: "codex", id: "r2" })!;
    const call = s.messages.find((m) => m.toolName === "apply_patch");
    expect(call?.toolCallId).toBe("call_p");
    expect(s.rawMeta.patchFiles).toEqual(["a.ts"]);
  });

  it("skips developer messages and environment_context-only user messages", () => {
    const lines = [
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/home/u</cwd>\n</environment_context>" }] }),
      item({ type: "message", role: "developer", content: [{ type: "input_text", text: "system instructions" }] }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "real question" }] }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "real answer" }] }),
    ];
    const s = parseCodexRollout(lines.join("\n"), { source: "codex", id: "r3" })!;
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "real question" });
    expect(s.messages[1]).toMatchObject({ role: "assistant", content: "real answer" });
  });

  it("supports the older flat {type:\"message\"} shape and survives malformed lines", () => {
    const l1 = JSON.stringify({ type: "message", payload: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00Z" });
    const l2 = JSON.stringify({ type: "message", payload: { role: "assistant", content: "yo" }, timestamp: "2026-01-01T00:00:01Z" });
    const s = parseCodexRollout(["not json at all", '{"type":"response_item","payload":', l1, l2].join("\n"), {
      source: "codex",
      id: "r4",
    })!;
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[0]?.content).toBe("hi");
  });

  it("returns null when nothing parses", () => {
    expect(parseCodexRollout("garbage\n", { source: "codex", id: "r5" })).toBeNull();
  });
});

describe("kimi wire.jsonl (fixture round-trip)", () => {
  const session = parseKimiWire(readFileSync("tests/fixtures/kimi/wire.jsonl", "utf8"), {
    source: "kimi-code",
    filePath: "tests/fixtures/kimi/wire.jsonl",
  });

  it("produces a schema-valid NIR session with agent-scoped id and tokens", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
    const s = session!;
    expect(s.id.endsWith("/main")).toBe(true);
    expect(s.model).toBe("kimi-code/k3");
    expect(s.messages[0]?.content).toBe("deploy docs to gh pages");
    expect(s.messages[0]?.role).toBe("user");
    const assistantWithTool = s.messages.find((m) => m.toolName === "exec_command");
    expect(assistantWithTool?.toolInput).toEqual({ cmd: "mkdocs gh-deploy" });
    const thinking = s.messages.find((m) => m.thinking);
    expect(thinking?.role).toBe("assistant");
    expect(thinking?.thinking).toContain("mkdocs gh-deploy is the simplest path");
    expect(s.rawMeta.projectHint).toBeUndefined();
    expect(s.rawMeta.agent).toBe("main");
    expect(s.rawMeta.durationMs).toBe(90692);
    expect(typeof s.rawMeta.estimatedTokens).toBe("number");
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.tokens).toEqual({ input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("kimi wire.jsonl (loop-event style)", () => {
  const WIRE = [
    JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1787754354863 }),
    JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "你好" }] }, time: 1787754354972 }),
    JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "think", think: "用户在打招呼" } }, time: 1787754354984 }),
    JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "你好！有什么可以帮你？" } }, time: 1787754355000 }),
    JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "tool_1", name: "Read", args: { path: "README.md" } }, time: 1787754355010 }),
    JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "tool_1", result: { output: "# README" } }, time: 1787754355100 }),
    JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "继续" }] }, time: 1787754356000 }),
    JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "好的。" } }, time: 1787754356100 }),
  ].join("\n");

  it("parses loop events and correlates tool.call/tool.result", () => {
    const s = parseKimiWire(WIRE, {
      source: "kimi-code",
      filePath: ".kimi-code/sessions/wd_proj_a1b2c3d4e5f6/session_1111/agents/main/wire.jsonl",
    })!;
    expect(s.id).toBe("1111/main");
    expect(s.rawMeta.projectHint).toBe("proj");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant", "tool", "user", "assistant"]);
    expect(s.messages[1]?.thinking).toBe("用户在打招呼");
    expect(s.messages[2]?.content).toBe("你好！有什么可以帮你？");
    const call = s.messages[3];
    expect(call?.toolName).toBe("Read");
    expect(call?.toolInput).toEqual({ path: "README.md" });
    expect(call?.toolCallId).toBe("tool_1");
    const result = s.messages[4];
    expect(result?.role).toBe("tool");
    expect(result?.content).toBe("# README");
    expect(result?.toolCallId).toBe("tool_1");
    // main lane: no agent tagging
    expect(s.messages.every((m) => m.agent === null)).toBe(true);
    expect(s.startedAt).toBe(new Date(1787754354972).toISOString());
  });

  it("tags non-main agent lanes via opts.agent", () => {
    const s = parseKimiWire(WIRE, { source: "kimi-code", id: "1111/agent-0", agent: "agent-0" })!;
    expect(s.messages.every((m) => m.agent === "agent-0")).toBe(true);
    expect(s.rawMeta.agent).toBe("agent-0");
  });
});

describe("session-json document / codewhale (fixture round-trip)", () => {
  const session = parseCodewhaleSession(readFileSync("tests/fixtures/codewhale/session.json", "utf8"), {
    source: "codewhale",
    filePath: "tests/fixtures/codewhale/session.json",
  });

  it("produces a schema-valid NIR session", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
    const s = session!;
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/webapp");
    expect(s.model).toBe("glm-4.7");
    expect(s.messages).toHaveLength(3);
    const toolMsg = s.messages.find((m) => m.toolName === "read_file");
    expect(toolMsg?.toolInput).toEqual({ path: "package.json" });
    expect(toolMsg?.toolCallId).toBe("call_a");
  });

  it("parses deepseek-style metadata and tool result messages", () => {
    const file = JSON.stringify({
      metadata: { id: "s2", title: "T", model: "deepseek", workspace: "/p", created_at: "2026-01-01T00:00:00Z" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "let me check", tool_calls: [{ function: { name: "read", arguments: "{\"p\":\"a\"}" } }] },
        { role: "tool", content: "file body" },
      ],
    });
    const s = parseCodewhaleSession(file, { source: "deepseek" })!;
    expect(s.id).toBe("s2");
    expect(s.title).toBe("T");
    expect(s.projectPath).toBe("/p");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(s.messages[2]?.toolName).toBe("read");
    expect(s.messages[2]?.toolInput).toEqual({ p: "a" });
    expect(s.messages[3]?.content).toBe("file body");
    expect(s.startedAt && new Date(s.startedAt).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for corrupt JSON", () => {
    expect(parseCodewhaleSession("{nope", { source: "codewhale", id: "bad" })).toBeNull();
  });
});
