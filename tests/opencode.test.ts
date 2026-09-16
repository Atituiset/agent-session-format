import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { nirSessionSchema, opencodeSessionFromDb, opencodeSessionsFromDb } from "../src/index";

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

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT);
           CREATE TABLE session(id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT,
             summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
             time_created INTEGER, time_updated INTEGER, model TEXT, cost REAL,
             tokens_input INTEGER, tokens_output INTEGER);
           CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
           CREATE TABLE part(id TEXT, message_id TEXT, data TEXT, time_created INTEGER);`);
  return db;
}

function seed(db: DatabaseSync): void {
  db.prepare("INSERT INTO project VALUES (?, ?)").run("p1", "/home/u/proj-worktree");
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "s1", "p1", "/home/u/proj", "Fix the thing", "0.6.3", 10, 2, 3,
    1735689600000, 1735689700000, null, 0.0042, 100, 200,
  );
  // user message with a text part
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "s1", JSON.stringify({ role: "user" }), 1735689600000);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt1", "m1", JSON.stringify({ id: "pt1", type: "text", text: "hi" }), 1735689600000);
  // assistant message with reasoning + tool + patch parts and per-message tokens
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
    "m2", "s1",
    JSON.stringify({ role: "assistant", model: { modelID: "deepseek-v3" }, time: { created: 1735689605000 }, tokens: { input: 50, output: 60 } }),
    1735689605000,
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt2", "m2", JSON.stringify({ id: "pt2", type: "reasoning", text: "想了一下" }), 1735689605001);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt3", "m2", JSON.stringify({ id: "pt3", type: "text", text: "on it" }), 1735689605002);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run(
    "pt4", "m2",
    JSON.stringify({ id: "pt4", type: "tool", tool: "bash", callID: "call_9", state: { status: "completed", input: { command: "ls" }, output: "a.txt" } }),
    1735689605003,
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt5", "m2", JSON.stringify({ id: "pt5", type: "patch", files: ["src/a.ts"] }), 1735689605004);
}

describe("opencode sqlite → NIR", () => {
  it("maps sessions/messages/parts into a schema-valid NIR session", async () => {
    const db = makeDb();
    seed(db);
    const sessions = await opencodeSessionsFromDb(db, { source: "opencode" });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(nirSessionSchema.safeParse(s).success).toBe(true);

    expect(s.id).toBe("s1");
    expect(s.title).toBe("Fix the thing");
    expect(s.sourceVersion).toBe("0.6.3");
    expect(s.cost).toBe(0.0042);
    expect(s.model).toBe("deepseek-v3"); // per-message modelID overrides the row
    expect(s.projectPath).toBe("/home/u/proj-worktree"); // worktree wins over directory
    expect(s.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(s.endedAt).toBe("2025-01-01T00:01:40.000Z");
    expect(s.tokens).toEqual({ input: 100, output: 200, cacheRead: 0, cacheWrite: 0 });
    expect(s.rawMeta.patchFiles).toEqual(["src/a.ts"]);

    const roles = s.messages.map((m) => m.role);
    // Part-derived messages (reasoning, tool call, tool output) come first in
    // part order; the accumulated text message is appended after them.
    expect(roles).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
    const [user, reasoning, call, out, text] = s.messages;
    expect(user?.content).toBe("hi");
    expect(reasoning?.thinking).toBe("想了一下");
    expect(text?.content).toBe("on it");
    expect(text?.tokens).toEqual({ input: 50, output: 60, cacheRead: 0, cacheWrite: 0 });
    expect(call?.toolName).toBe("bash");
    expect(call?.toolInput).toEqual({ command: "ls" });
    expect(call?.toolCallId).toBe("call_9");
    expect(out?.content).toBe("a.txt");
    expect(out?.toolCallId).toBe("call_9");
  });

  it("skips corrupt message/part rows instead of failing the session", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", null, "/d", "T", null, 0, 0, 0, 1735689600000, 0, null, 0, 0, 0,
    );
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "s1", "{corrupt json", 1735689600000);
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m2", "s1", JSON.stringify({ role: "assistant" }), 1735689600001);
    db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt-bad", "m2", "{also corrupt", 1735689600001);
    db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt2", "m2", JSON.stringify({ id: "pt2", type: "text", text: "ok" }), 1735689600002);

    const sessions = await opencodeSessionsFromDb(db, { source: "opencode" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toHaveLength(1);
    expect(sessions[0]!.messages[0]?.content).toBe("ok");
  });

  it("accepts an async (Promise-returning) SqliteDb implementation", async () => {
    const sync = makeDb();
    seed(sync);
    const asyncDb = {
      prepare: (sql: string) => ({
        all: async (...params: unknown[]) => sync.prepare(sql).all(...(params as never[])) as unknown[],
      }),
    };
    const sessions = await opencodeSessionsFromDb(asyncDb, { source: "opencode" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe("s1");
  });
});

describe("opencodeSessionFromDb (single session)", () => {
  function seedTwoSessions(): DatabaseSync {
    const db = makeDb();
    seed(db); // session "s1"
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s2", null, "/other", "Second", "0.6.3", 0, 0, 0, 1735689800000, 1735689900000, "glm5", 0.001, 5, 6,
    );
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m9", "s2", JSON.stringify({ role: "user" }), 1735689800000);
    db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("pt9", "m9", JSON.stringify({ id: "pt9", type: "text", text: "second session here" }), 1735689800000);
    return db;
  }

  it("returns NIR identical to the whole-DB variant's entry for that session", async () => {
    const db = seedTwoSessions();
    const all = await opencodeSessionsFromDb(db, { source: "opencode" });
    expect(all.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    for (const id of ["s1", "s2"]) {
      const single = await opencodeSessionFromDb(db, id, { source: "opencode" });
      expect(single).not.toBeNull();
      expect(nirSessionSchema.safeParse(single).success).toBe(true);
      expect(single).toEqual(all.find((s) => s.id === id));
    }
  });

  it("scopes every query to the requested session", async () => {
    const db = seedTwoSessions();
    const rec = recording(db);
    const single = await opencodeSessionFromDb(rec.db, "s2", { source: "opencode" });
    expect(single?.id).toBe("s2");
    // The session row lookup filters on s.id.
    const sessionQuery = rec.calls.find((c) => c.sql.includes("FROM session"));
    expect(sessionQuery?.sql).toContain("WHERE s.id = ?");
    expect(sessionQuery?.params).toEqual(["s2"]);
    // Every message query targets only s2; no parameter ever references s1.
    const messageQueries = rec.calls.filter((c) => c.sql.includes("FROM message"));
    expect(messageQueries.length).toBeGreaterThan(0);
    expect(messageQueries.every((c) => c.params.length === 1 && c.params[0] === "s2")).toBe(true);
    expect(rec.calls.flatMap((c) => c.params)).not.toContain("s1");
    // Part queries only touch s2's message ids.
    const partParams = rec.calls.filter((c) => c.sql.includes("FROM part")).flatMap((c) => c.params);
    expect(partParams).toEqual(["m9"]);
  });

  it("returns null for an unknown session id", async () => {
    const db = seedTwoSessions();
    expect(await opencodeSessionFromDb(db, "nope", { source: "opencode" })).toBeNull();
  });
});
