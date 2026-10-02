import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  nirSessionSchema,
  opencodeSessionFromDb,
  parseAntigravityTranscript,
  parseClaudeCodeTranscript,
  parseCodexRollout,
  parseKimiWire,
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

describe("codex tool outcomes", () => {
  const doc = (output: string) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output },
    }) + "\n";

  it("reads the newer 'Exit code: N' envelope", () => {
    const s = parseCodexRollout(doc("Exit code: 0\nWall time: 0.3 seconds\nOutput:\nSuccess. Updated book.toml"), {
      source: "codex",
      id: "s1",
    });
    const r = s?.messages.find((m) => m.role === "tool");
    expect(r?.toolResult).toMatchObject({ status: "success", method: "derived" });
    expect(r?.toolResult?.detail.exitCode).toBe(0);
    expect(r?.toolResult?.detail.envelope).toBe("exit_code");
  });

  it("reads a non-zero 'Exit code' as an error and keeps evidence", () => {
    const s = parseCodexRollout(doc("Exit code: 2\nWall time: 0.1 seconds\nOutput:\nboom"), {
      source: "codex",
      id: "s1",
    });
    const r = s?.messages.find((m) => m.role === "tool");
    expect(r?.toolResult?.status).toBe("error");
    expect(r?.toolResult?.detail.exitCode).toBe(2);
    expect(r?.toolResult?.errorText).toContain("Exit code: 2");
  });

  it("reads the older 'Process exited with code N' envelope", () => {
    const s = parseCodexRollout(
      doc("chunk-id 4d2f3\nWall time: 0.1356 seconds\nProcess exited with code 1\nOriginal token count: 340\nOutput:\ntotal 92"),
      { source: "codex", id: "s1" },
    );
    const r = s?.messages.find((m) => m.role === "tool");
    expect(r?.toolResult).toMatchObject({ status: "error", method: "derived" });
    expect(r?.toolResult?.detail.envelope).toBe("process_exited");
  });

  it("treats 'Process exited with code 0' as success", () => {
    const s = parseCodexRollout(
      doc("chunk-id 4d2f3\nWall time: 0.0 seconds\nProcess exited with code 0\nOutput:\n/home/x"),
      { source: "codex", id: "s1" },
    );
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult?.status).toBe("success");
  });

  it("reads the npm/pnpm 'Command failed with exit code N' envelope", () => {
    const s = parseCodexRollout(
      doc("ELIFECYCLE\\u{2009} Command failed with exit code 1.\", output: ExecToolCallOutput { exit_code: 1"),
      { source: "codex", id: "s1" },
    );
    const r = s?.messages.find((m) => m.role === "tool");
    expect(r?.toolResult?.status).toBe("error");
    expect(r?.toolResult?.detail.envelope).toBe("command_failed");
  });

  it("leaves plain agent output unmeasured", () => {
    // The critical contrast: codex's envelopes are machine-written, so matching
    // them is exact. Agent prose containing "FAILED" must stay unjudged —
    // regexing that is what produced ~100% false positives on other harnesses.
    const s = parseCodexRollout(doc("FAILED tests/test_x.py\nAssertionError"), {
      source: "codex",
      id: "s1",
    });
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult).toBeUndefined();
  });
});

describe("kimi task verdicts", () => {
  const wire = (info: Record<string, unknown>) =>
    JSON.stringify({ type: "task.terminated", agentId: "agent-0", info, time: 1790612683010 }) +
    "\n";

  const OPTS = {
    source: "kimi-code",
    id: "s1",
    filePath: "/x/session_s1/agents/agent-0/wire.jsonl",
  } as const;

  it("completed with exitCode 0 is success", () => {
    const s = parseKimiWire(wire({ taskId: "bash-1", status: "completed", exitCode: 0, kind: "process" }), OPTS);
    const r = s?.messages.find((m) => m.role === "tool");
    expect(r?.toolResult).toMatchObject({ status: "success", method: "source_status" });
    expect(r?.toolResult?.detail.status).toBe("completed");
  });

  it("completed with a NON-zero exitCode is an error", () => {
    // A command can finish and still have failed — the status alone is not enough.
    const s = parseKimiWire(wire({ taskId: "bash-1", status: "completed", exitCode: 2, kind: "process" }), OPTS);
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult?.status).toBe("error");
  });

  it("failed / killed / lost are errors, kept distinct in detail.status", () => {
    for (const st of ["failed", "killed", "lost"]) {
      const s = parseKimiWire(wire({ taskId: "b1", status: st, kind: "process" }), OPTS);
      const r = s?.messages.find((m) => m.role === "tool")?.toolResult;
      expect(r?.status).toBe("error");
      expect(r?.detail.status).toBe(st);
    }
  });

  it("timed_out is CANCELLED, not error", () => {
    // The command did not report failure — it was cut off. Mapping it to error
    // would invent failures that never happened.
    const s = parseKimiWire(wire({ taskId: "b1", status: "timed_out", kind: "process" }), OPTS);
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult?.status).toBe("cancelled");
  });

  it("running is unknown, not a failure", () => {
    const s = parseKimiWire(wire({ taskId: "b1", status: "running", kind: "process" }), OPTS);
    expect(s?.messages.find((m) => m.role === "tool")?.toolResult?.status).toBe("unknown");
  });

  it("stopReason is preserved verbatim", () => {
    const s = parseKimiWire(
      wire({ taskId: "b1", status: "killed", stopReason: "curl 挂起,改用 python 获取", kind: "process" }),
      OPTS,
    );
    const r = s?.messages.find((m) => m.role === "tool")?.toolResult;
    expect(r?.detail.stopReason).toBe("curl 挂起,改用 python 获取");
    expect(r?.errorText).toContain("挂起");
  });

  it("the tool result pairs with the taskId that started the command", () => {
    const s = parseKimiWire(wire({ taskId: "bash-zzmkjcya", status: "completed", exitCode: 0 }), OPTS);
    expect(s?.messages.find((m) => m.role === "tool")?.toolCallId).toBe("bash-zzmkjcya");
  });

  it("agent-kind tasks are labelled as delegation", () => {
    const s = parseKimiWire(
      wire({ taskId: "a1", status: "completed", exitCode: 0, kind: "agent", agentId: "agent-3" }),
      OPTS,
    );
    expect(s?.messages.find((m) => m.role === "tool")?.toolName).toBe("task");
  });

  it("a row with no info object is skipped rather than crashing", () => {
    const s = parseKimiWire(JSON.stringify({ type: "task.terminated", time: 1 }) + "\n", OPTS);
    expect(s?.messages.find((m) => m.role === "tool")).toBeUndefined();
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