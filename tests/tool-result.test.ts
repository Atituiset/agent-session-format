import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  nirSessionSchema,
  opencodeSessionFromDb,
  parseAntigravityTranscript,
  parseClaudeCodeTranscript,
  parseCodexRollout,
} from "../src/index";

/**
 * NIR 0.5.0 — structured tool outcomes.
 *
 * Until 0.5.0 NIR carried no success/failure signal, so consumers had to regex
 * tool output. Measured on a real corpus that recovered a verdict for ~0.2% of
 * opencode results and ~11% of Claude's — low enough that any outcome-conditioned
 * analysis was mostly measuring which harness writes exit codes into transcripts.
 *
 * These tests pin, per source, whether a verdict is reported and how it was
 * obtained. The `absent` cases matter as much as the present ones: a consumer
 * must be able to tell "the source said nothing" from "it succeeded".
 */

function claudeDoc(body: unknown[]): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "go" },
      timestamp: "2026-05-01T10:00:00.000Z",
      sessionId: "s1",
    }) + "\n" +
    JSON.stringify({
      type: "assistant",
      message: { id: "m1", role: "assistant", model: "claude-opus-4-7", content: body },
      timestamp: "2026-05-01T10:00:01.000Z",
      sessionId: "s1",
    }) +
    "\n"
  );
}

describe("claude-code tool outcomes", () => {
  it("reports is_error=false as a source-reported success", () => {
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_result", tool_use_id: "t1", content: "file body", is_error: false },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult).toEqual({
      status: "success",
      method: "source_is_error",
      errorText: null,
      detail: {},
    });
  });

  it("reports is_error=true as a source-reported error and keeps the text", () => {
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat missing" } },
      { type: "tool_result", tool_use_id: "t1", content: "cat: missing: No such file", is_error: true },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult?.status).toBe("error");
    expect(result?.toolResult?.method).toBe("source_is_error");
    expect(result?.toolResult?.errorText).toContain("No such file");
  });

  it("omits toolResult when the source row has no is_error key", () => {
    // Absent ≠ success. A missing key must stay unmeasured.
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_result", tool_use_id: "t1", content: "body" },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult).toBeUndefined();
  });

  it("never puts toolResult on a tool-call message", () => {
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_result", tool_use_id: "t1", content: "body", is_error: false },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    const call = s?.messages.find((m) => m.role === "assistant");
    expect(call?.toolResult).toBeUndefined();
  });
});

function makeOcDb(): DatabaseSync {
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

function seedOcPart(db: DatabaseSync, part: unknown): void {
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
    "m1",
    "s1",
    JSON.stringify({ role: "assistant", time: { created: 1735689605000 } }),
    1735689605000,
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run(
    "p1",
    "m1",
    JSON.stringify(part),
    1735689605001,
  );
}

describe("opencode tool outcomes", () => {
  it("maps state.status=completed to success", async () => {
    const db = makeOcDb();
    db.prepare("INSERT INTO project VALUES (?,?)").run("p1", "/repo");
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", "p1", "/repo", "t", "0.6.3", 0, 0, 0, 1735689600000, 1735689700000, null, 0, 0, 0,
    );
    seedOcPart(db, {
      id: "p1", type: "tool", tool: "bash", callID: "c1",
      state: { status: "completed", input: { command: "ls" }, output: "a.txt" },
    });
    const s = await opencodeSessionFromDb(db, "s1", { source: "opencode" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult).toEqual({
      status: "success",
      method: "source_status",
      errorText: null,
      detail: {},
    });
  });

  it("maps state.status=error and preserves state.error text", async () => {
    const db = makeOcDb();
    db.prepare("INSERT INTO project VALUES (?,?)").run("p1", "/repo");
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", "p1", "/repo", "t", "0.6.3", 0, 0, 0, 1735689600000, 1735689700000, null, 0, 0, 0,
    );
    seedOcPart(db, {
      id: "p1", type: "tool", tool: "read", callID: "c1",
      state: { status: "error", input: { filePath: "/gone.c" }, output: "", error: "File not found: /gone.c" },
    });
    const s = await opencodeSessionFromDb(db, "s1", { source: "opencode" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult?.status).toBe("error");
    expect(result?.toolResult?.errorText).toBe("File not found: /gone.c");
  });

  it("emits a tool message for an errored tool that has NO output", async () => {
    // This is the case regex recovery could never see: a failed tool frequently
    // produces no output at all, so before 0.5.0 it vanished from the trace.
    const db = makeOcDb();
    db.prepare("INSERT INTO project VALUES (?,?)").run("p1", "/repo");
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", "p1", "/repo", "t", "0.6.3", 0, 0, 0, 1735689600000, 1735689700000, null, 0, 0, 0,
    );
    seedOcPart(db, {
      id: "p1", type: "tool", tool: "bash", callID: "c1",
      state: { status: "error", input: { command: "false" } },
    });
    const s = await opencodeSessionFromDb(db, "s1", { source: "opencode" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result).toBeDefined();
    expect(result?.toolResult?.status).toBe("error");
    expect(result?.content).toBe("");
  });

  it("omits toolResult when the part carries no status", async () => {
    const db = makeOcDb();
    db.prepare("INSERT INTO project VALUES (?,?)").run("p1", "/repo");
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", "p1", "/repo", "t", "0.6.3", 0, 0, 0, 1735689600000, 1735689700000, null, 0, 0, 0,
    );
    seedOcPart(db, {
      id: "p1", type: "tool", tool: "bash", callID: "c1",
      state: { input: { command: "ls" }, output: "a.txt" },
    });
    const s = await opencodeSessionFromDb(db, "s1", { source: "opencode" });
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult).toBeUndefined();
  });
});

describe("antigravity tool outcomes", () => {
  const row = (output: string) =>
    JSON.stringify({
      type: "RUN_COMMAND",
      command: "npm run dev",
      output,
      timestamp: "2026-05-26T16:43:47Z",
    }) + "\n";

  it("marks a failed command as derived with its exit code", () => {
    const s = parseAntigravityTranscript(
      row("Created At: x\nCompleted At: y\n\n\t\tThe command failed with exit code: 1\n\t\tOutput:\n\t\tboom"),
      { source: "gemini-antigravity", id: "s1" },
    );
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result?.toolResult?.status).toBe("error");
    expect(result?.toolResult?.method).toBe("derived");
    expect(result?.toolResult?.detail.exitCode).toBe(1);
  });

  it("marks a completed command as derived success", () => {
    const s = parseAntigravityTranscript(
      row("Created At: x\nCompleted At: y\n\n\t\tThe command completed successfully.\n\t\tOutput:\n\t\tok"),
      { source: "gemini-antigravity", id: "s1" },
    );
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult?.status).toBe("success");
  });

  it("leaves arbitrary output unmeasured", () => {
    const s = parseAntigravityTranscript(row("some random output"), {
      source: "gemini-antigravity",
      id: "s1",
    });
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult).toBeUndefined();
  });
});

describe("sources with no structured verdict", () => {
  it("codex function_call_output carries no toolResult", () => {
    // Verified against 98 real rollout rows: the payload is exactly
    // {type, call_id, output} — codex omits the exit code it clearly has.
    const doc =
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "boom" },
      }) + "\n";
    const s = parseCodexRollout(doc, { source: "codex", id: "s1" });
    const result = s?.messages.find((m) => m.role === "tool");
    expect(result).toBeDefined();
    expect(result?.toolResult).toBeUndefined();
  });
});

describe("schema", () => {
  it("accepts a session carrying toolResult and stays schema-valid", () => {
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } },
      { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    expect(nirSessionSchema.safeParse(s).success).toBe(true);
  });

  it("rejects an unknown status value", () => {
    const doc = claudeDoc([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } },
      { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
    ]);
    const s = parseClaudeCodeTranscript(doc, { source: "claude-code", id: "s1" });
    const broken = structuredClone(s);
    const tool = broken?.messages.find((m) => m.role === "tool");
    if (tool?.toolResult) tool.toolResult.status = "exploded" as never;
    expect(nirSessionSchema.safeParse(broken).success).toBe(false);
  });
});