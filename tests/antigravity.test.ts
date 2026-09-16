import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nirSessionSchema, parseAntigravityTranscript } from "../src/index";

describe("antigravity transcript (fixture round-trip)", () => {
  const filePath = "tests/fixtures/antigravity/transcript.jsonl";
  const session = parseAntigravityTranscript(readFileSync(filePath, "utf8"), {
    source: "antigravity",
    id: "c1",
  });

  it("produces a schema-valid NIR session", () => {
    expect(session).not.toBeNull();
    expect(nirSessionSchema.safeParse(session).success).toBe(true);
  });

  it("maps event types to NIR messages", () => {
    const s = session!;
    expect(s.id).toBe("c1");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant", "tool", "assistant"]);
    // <USER_REQUEST> unwrapped
    expect(s.messages[0]?.content).toBe("add a health check endpoint");
    // PLANNER_RESPONSE content + tool_calls
    expect(s.messages[1]?.content).toBe("I'll add the endpoint now.");
    expect(s.messages[2]).toMatchObject({ toolName: "write_file", toolInput: { path: "src/health.ts" } });
    // RUN_COMMAND → bash call + tool output
    expect(s.messages[3]).toMatchObject({ toolName: "bash", toolInput: { command: "curl localhost:3000/health" } });
    expect(s.messages[4]).toMatchObject({ role: "tool", toolName: "bash", content: '{"ok":true}' });
    // VIEW_FILE → read
    expect(s.messages[5]).toMatchObject({ toolName: "read", toolInput: { path: "src/health.ts" } });
    expect(s.messages[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("derives the id from the /brain/ path segment", () => {
    const s = parseAntigravityTranscript(readFileSync(filePath, "utf8"), {
      source: "antigravity",
      filePath: ".gemini/antigravity-cli/brain/conv-9/.system_generated/logs/transcript.jsonl",
    });
    expect(s!.id).toBe("conv-9");
  });

  it("returns null when nothing parses", () => {
    expect(parseAntigravityTranscript("garbage\n", { source: "antigravity", id: "x" })).toBeNull();
  });
});
