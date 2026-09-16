import { describe, expect, it } from "vitest";
import { makeNirSession, nirSessionSchema } from "../src/index";

const validSession = {
  id: "s1",
  source: "codex",
  sourceVersion: "0.118.0",
  projectPath: "/home/u/proj",
  startedAt: "2026-04-04T15:24:06.895Z",
  endedAt: null,
  messages: [
    {
      role: "user",
      content: "fix the bug",
      timestamp: "2026-04-04T15:24:07.000Z",
      toolName: null,
      toolInput: null,
      model: null,
    },
  ],
};

describe("nir schema", () => {
  it("accepts a minimal valid session", () => {
    const s = makeNirSession(validSession);
    expect(s.id).toBe("s1");
    expect(s.rawMeta).toEqual({});
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.thinking).toBeNull();
  });

  it("defaults token usage fields to zero", () => {
    const s = makeNirSession({
      ...validSession,
      messages: [{ ...validSession.messages[0], tokens: { input: 10 } }],
    });
    expect(s.messages[0]?.tokens).toEqual({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("rejects unknown role", () => {
    const bad = {
      ...validSession,
      messages: [{ ...validSession.messages[0], role: "alien" }],
    };
    expect(nirSessionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects session without messages", () => {
    const bad = { ...validSession, messages: [] };
    expect(nirSessionSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults the additive extension fields", () => {
    const s = makeNirSession(validSession);
    expect(s.title).toBeNull();
    expect(s.model).toBeNull();
    expect(s.cost).toBeNull();
    expect(s.tokens).toBeUndefined();
    const m = s.messages[0]!;
    expect(m.toolCallId).toBeNull();
    expect(m.agent).toBeNull();
    expect(m.agentLabel).toBeNull();
  });

  it("accepts the extension fields when present", () => {
    const s = makeNirSession({
      ...validSession,
      title: "My session",
      cost: 0.42,
      model: "gpt-5",
      tokens: { input: 1, output: 2 },
      messages: [
        {
          ...validSession.messages[0],
          toolCallId: "call_1",
          agent: "agent-0",
          agentLabel: "explore · agent-0",
        },
      ],
    });
    expect(s.title).toBe("My session");
    expect(s.cost).toBe(0.42);
    expect(s.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(s.messages[0]?.toolCallId).toBe("call_1");
    expect(s.messages[0]?.agent).toBe("agent-0");
  });
});
