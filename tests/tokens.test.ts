import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  extractTokens,
  opencodeSessionsFromDb,
  parseCodexRollout,
  parseKimiWire,
} from "../src/index";

describe("extractTokens normalization", () => {
  it("codex/responses: input_tokens INCLUDES cache — cached part moves to cacheRead", () => {
    expect(
      extractTokens({
        input_tokens: 470357,
        cached_input_tokens: 433920,
        cache_write_input_tokens: 0,
        output_tokens: 2653,
        reasoning_output_tokens: 82,
        total_tokens: 473010,
      }),
    ).toEqual({ input: 36437, output: 2653, cacheRead: 433920, cacheWrite: 0 });
  });

  it("anthropic style: input_tokens is already fresh; cache fields stay separate", () => {
    expect(
      extractTokens({
        input_tokens: 1200,
        output_tokens: 300,
        cache_read_input_tokens: 50000,
        cache_creation_input_tokens: 8000,
      }),
    ).toEqual({ input: 1200, output: 300, cacheRead: 50000, cacheWrite: 8000 });
  });

  it("kimi wire: inputOther/inputCacheRead/inputCacheCreation", () => {
    expect(
      extractTokens({ inputOther: 7979, output: 265, inputCacheRead: 18944, inputCacheCreation: 0 }),
    ).toEqual({ input: 7979, output: 265, cacheRead: 18944, cacheWrite: 0 });
  });

  it("opencode message tokens: nested cache object; reasoning folds into output", () => {
    expect(
      extractTokens({ input: 1000, output: 100, reasoning: 50, cache: { read: 9000, write: 500 } }),
    ).toEqual({ input: 1000, output: 150, cacheRead: 9000, cacheWrite: 500 });
  });

  it("cache-only usage still reports; unknown shapes return undefined", () => {
    expect(extractTokens({ cache_read_input_tokens: 123 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 123,
      cacheWrite: 0,
    });
    expect(extractTokens({ hello: "world" })).toBeUndefined();
    expect(extractTokens(null)).toBeUndefined();
  });
});

describe("parseCodexRollout token_count", () => {
  const item = (payload: unknown, timestamp = "2026-01-01T00:00:00Z") =>
    JSON.stringify({ timestamp, type: "response_item", payload });

  it("takes the latest cumulative total_token_usage as the session totals", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "s1", cwd: "/p" } }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 },
          },
        },
      }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }, "2026-01-01T00:00:02Z"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 5000, cached_input_tokens: 4200, output_tokens: 120, total_tokens: 5120 },
          },
        },
      }),
    ].join("\n");
    const s = parseCodexRollout(lines, { source: "codex" })!;
    expect(s.tokens).toEqual({ input: 800, output: 120, cacheRead: 4200, cacheWrite: 0 });
    const lastAssistant = s.messages.filter((m) => m.role === "assistant").at(-1);
    expect(lastAssistant?.tokens).toEqual(s.tokens);
  });
});

describe("parseKimiWire usage.record", () => {
  it("sums turn-scoped records including cache; totals are not zeroed out", () => {
    const lines = [
      JSON.stringify({ type: "profile.bind", modelAlias: "kimi-k3", time: 1790612024000 }),
      JSON.stringify({
        type: "context.append_message",
        time: 1790612024100,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "context.append_message",
        time: 1790612024200,
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "usage.record",
        agentId: "main",
        model: "kimi-code/k3",
        usage: { inputOther: 7979, output: 265, inputCacheRead: 18944, inputCacheCreation: 1200 },
        usageScope: "turn",
        time: 1790612024629,
      }),
      JSON.stringify({
        type: "usage.record",
        agentId: "main",
        usage: { inputOther: 500, output: 100, inputCacheRead: 6000, inputCacheCreation: 0 },
        usageScope: "turn",
        time: 1790612025000,
      }),
    ].join("\n");
    const s = parseKimiWire(lines, { source: "kimi-code", id: "k1" })!;
    expect(s.tokens).toEqual({ input: 8479, output: 365, cacheRead: 24944, cacheWrite: 1200 });
    const lastAssistant = s.messages.filter((m) => m.role === "assistant").at(-1);
    expect(lastAssistant?.tokens).toEqual(s.tokens);
  });
});

describe("opencode cache columns", () => {
  it("modern schema: session and message tokens carry cache + reasoning", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
        version TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
        time_created INTEGER, time_updated INTEGER, model TEXT, cost REAL,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
      INSERT INTO project VALUES ('p1', '/w');
      INSERT INTO session VALUES ('s1', 'p1', '/w', 't', '1.0', 0, 0, 0, 1000, 2000, 'm', 0,
        1000, 100, 50, 9000, 500);
      INSERT INTO message VALUES ('m1', 's1', '{"role":"assistant","time":{"created":1500},"tokens":{"input":1000,"output":100,"reasoning":50,"cache":{"read":9000,"write":500}}}', 1500);
      INSERT INTO part VALUES ('p1', 'm1', '{"type":"text","text":"answer"}', 1500);
    `);
    const [s] = await opencodeSessionsFromDb(db, { source: "opencode" });
    expect(s.tokens).toEqual({ input: 1000, output: 150, cacheRead: 9000, cacheWrite: 500 });
    expect(s.messages[0]?.tokens).toEqual({ input: 1000, output: 150, cacheRead: 9000, cacheWrite: 500 });
    db.close();
  });
});
