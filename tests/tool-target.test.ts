import { describe, expect, it } from "vitest";
import { makeMsg, targetPathOf, FILE_PATH_KEYS } from "../src/util";

/**
 * toolTarget: the field-spelling fact, hoisted out of four consumers.
 *
 * It used to be re-guessed independently by session-forge (twice), behavior-lab,
 * and the viewer, each with a different key list. This is the single owner.
 */
describe("targetPathOf", () => {
  it("reads every file-path spelling measured across harnesses", () => {
    for (const key of FILE_PATH_KEYS) {
      expect(targetPathOf({ [key]: "/a/b.ts" })).toBe("/a/b.ts");
    }
  });

  it("prefers the specific spelling over the generic one", () => {
    // opencode carries both on some tools; the specific key is the real target.
    expect(targetPathOf({ path: "/generic", file_path: "/specific" })).toBe("/specific");
    expect(targetPathOf({ path: "/generic", filePath: "/specific" })).toBe("/specific");
  });

  it("does NOT treat a search query as a path", () => {
    // `query` was in the old lists. It is a grep pattern, not a file — including
    // it is what let opencode's extractTarget return a search term as a target.
    expect(targetPathOf({ query: "TODO fix" })).toBeNull();
    expect(targetPathOf({ pattern: "**/*.ts" })).toBeNull();
  });

  it("returns null for inputs that cannot carry a path", () => {
    expect(targetPathOf(null)).toBeNull();
    expect(targetPathOf(undefined)).toBeNull();
    expect(targetPathOf("a string")).toBeNull();
    expect(targetPathOf([{ file_path: "/a" }])).toBeNull();
    expect(targetPathOf({})).toBeNull();
  });

  it("ignores empty and non-string values", () => {
    expect(targetPathOf({ file_path: "" })).toBeNull();
    expect(targetPathOf({ file_path: 42 })).toBeNull();
  });
});

describe("makeMsg derives toolTarget", () => {
  it("derives the target from the input without the caller asking", () => {
    const m = makeMsg({ role: "assistant", toolName: "Read", toolInput: { file_path: "/a.ts" } });
    expect(m.toolTarget).toBe("/a.ts");
  });

  it("leaves it null for calls that touch no file", () => {
    // Bash, WebSearch and friends legitimately have no target. Saying so is the
    // point: absence is a fact, not a gap.
    expect(makeMsg({ role: "assistant", toolName: "Bash", toolInput: { command: "ls" } }).toolTarget).toBeNull();
  });

  it("does not clobber an explicitly-passed target", () => {
    const m = makeMsg({
      role: "assistant",
      toolName: "apply_patch",
      toolInput: { raw: "*** Update File: /a.ts" },
      toolTarget: "/a.ts",
    });
    expect(m.toolTarget).toBe("/a.ts");
  });

  it("survives the schema round-trip — a derived field must not be stripped", () => {
    // This is the failure the measurement caught: makeMsg set the field correctly
    // and `nirSessionSchema.parse` dropped it, because the field had been added to
    // the object literal but the schema it is validated against did not declare it.
    const session = makeNirSessionFor([
      makeMsg({ role: "assistant", toolName: "Read", toolInput: { file_path: "/a.ts" } }),
    ]);
    expect(session.messages[0]!.toolTarget).toBe("/a.ts");
  });
});

// local helper so this file does not depend on buildSession's full surface
import { makeNirSession } from "../src/schema";
function makeNirSessionFor(messages: ReturnType<typeof makeMsg>[]) {
  return makeNirSession({
    id: "s",
    source: "test",
    sourceVersion: null,
    projectPath: null,
    startedAt: null,
    endedAt: null,
    messages,
  });
}