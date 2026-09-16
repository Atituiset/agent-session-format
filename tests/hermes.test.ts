import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hermesSessionFromDb, hermesSessionsFromDb, nirSessionSchema, parseHermesDump } from "../src/index";

/** Records every (sql, params) call so tests can assert query scoping. */
function recording(db: DatabaseSync) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const wrapped = {
    prepare: (sql: string) => ({
      all: (...params: unknown[]) => {
        calls.push({ sql, params });
        return db.prepare(sql).all(...(params as never[])) as unknown[];
      },
    }),
  };
  return { calls, db: wrapped };
}

describe("hermes request dump (fixture round-trip)", () => {
  const session = parseHermesDump(readFileSync("tests/fixtures/hermes/request_dump_s1_001.json", "utf8"), {
    source: "hermes",
    id: "s1",
  });

  it("produces a schema-valid NIR session", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
    const s = session!;
    expect(s.id).toBe("s1");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "assistant", "tool"]);
    expect(s.messages[1]?.content).toBe("hi");
    const call = s.messages[3];
    expect(call?.toolName).toBe("Read");
    expect(call?.toolInput).toEqual({ path: "README.md" });
    expect(call?.toolCallId).toBe("call_1");
    expect(s.messages[4]?.content).toBe("# README");
    expect(s.messages[0]?.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null for corrupt JSON", () => {
    expect(parseHermesDump("{nope", { source: "hermes", id: "bad" })).toBeNull();
  });
});

function makeStateDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT, title TEXT, display_name TEXT, started_at REAL, message_count INTEGER, cwd TEXT, model TEXT, archived INTEGER, hidden INTEGER);
           CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, reasoning_content TEXT, active INTEGER);`);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)").run(
    "20260602_233910_562888", null, "My Session", 1780414886.4, 2, "/home/u/proj", "glm5", 0, 0,
  );
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
    1, "20260602_233910_562888", "user", "hello", null, null, 1780414888.5, null, 1,
  );
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
    2, "20260602_233910_562888", "assistant", "hi",
    JSON.stringify([{ id: "call_1", function: { name: "Read", arguments: "{}" } }]),
    null, 1780414890.5, "thinking...", 1,
  );
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
    3, "20260602_233910_562888", "tool", "file contents", null, "call_1", 1780414891.5, null, 1,
  );
  // archived session and inactive message are excluded
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)").run("arch", null, "Old", 1780414886.4, 1, "/x", "glm5", 1, 0);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
    4, "20260602_233910_562888", "user", "deleted", null, null, 1780414892.5, null, 0,
  );
  return db;
}

describe("hermes state.db → NIR", () => {
  it("maps sessions and messages, honoring archived/hidden/active flags", async () => {
    const sessions = await hermesSessionsFromDb(makeStateDb(), { source: "hermes" });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(nirSessionSchema.safeParse(s).success).toBe(true);
    expect(s.id).toBe("20260602_233910_562888");
    expect(s.title).toBe("My Session");
    expect(s.model).toBe("glm5");
    expect(s.projectPath).toBe("/home/u/proj");
    expect(s.startedAt).toBe(new Date(1780414886.4 * 1000).toISOString());

    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant", "tool"]);
    expect(s.messages[1]?.thinking).toBe("thinking...");
    expect(s.messages[2]?.content).toBe("hi");
    const call = s.messages[3];
    expect(call?.toolName).toBe("Read");
    expect(call?.toolCallId).toBe("call_1");
    const out = s.messages[4];
    expect(out?.content).toBe("file contents");
    expect(out?.toolCallId).toBe("call_1");
    expect(s.messages.some((m) => m.content === "deleted")).toBe(false);
  });
});

describe("hermesSessionFromDb (single session)", () => {
  const SID = "20260602_233910_562888";

  function seedTwoSessions(): DatabaseSync {
    const db = makeStateDb(); // active session SID + archived "arch"
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)").run(
      "other", "Other", null, 1780415000.0, 1, "/elsewhere", "glm5", 0, 0,
    );
    db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
      10, "other", "user", "unrelated", null, null, 1780415001.0, null, 1,
    );
    return db;
  }

  it("returns NIR identical to the whole-DB variant's entry for that session", async () => {
    const db = seedTwoSessions();
    const all = await hermesSessionsFromDb(db, { source: "hermes" });
    expect(all.map((s) => s.id).sort()).toEqual([SID, "other"].sort());
    for (const id of [SID, "other"]) {
      const single = await hermesSessionFromDb(db, id, { source: "hermes" });
      expect(single).not.toBeNull();
      expect(nirSessionSchema.safeParse(single).success).toBe(true);
      expect(single).toEqual(all.find((s) => s.id === id));
    }
  });

  it("scopes every query to the requested session", async () => {
    const db = seedTwoSessions();
    const rec = recording(db);
    const single = await hermesSessionFromDb(rec.db, SID, { source: "hermes" });
    expect(single?.id).toBe(SID);
    const sessionQuery = rec.calls.find((c) => c.sql.includes("FROM sessions"));
    expect(sessionQuery?.sql).toContain("id = ?");
    expect(sessionQuery?.params).toEqual([SID]);
    const messageQueries = rec.calls.filter((c) => c.sql.includes("FROM messages"));
    expect(messageQueries.length).toBeGreaterThan(0);
    expect(messageQueries.every((c) => c.params.length === 1 && c.params[0] === SID)).toBe(true);
    expect(rec.calls.flatMap((c) => c.params)).not.toContain("other");
  });

  it("returns null for an unknown session id", async () => {
    const db = seedTwoSessions();
    expect(await hermesSessionFromDb(db, "nope", { source: "hermes" })).toBeNull();
  });

  it("returns null for an archived session (same filter as the whole-DB variant)", async () => {
    const db = seedTwoSessions();
    expect(await hermesSessionFromDb(db, "arch", { source: "hermes" })).toBeNull();
  });
});
