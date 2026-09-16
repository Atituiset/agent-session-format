import type { NirMessage, NirSession } from "../schema.js";
import { buildSession, makeMsg } from "../util.js";
import type { ParseOptions } from "./claude-code.js";

const MAX_CONTENT = 30_000;

/**
 * Parse one Antigravity (Gemini CLI) `transcript.jsonl`. Pure: content in,
 * NIR out. Returns null when no messages parse.
 *
 * The id defaults to the brain directory segment (`.../brain/<id>/...`) when
 * `filePath` contains one, else the file name.
 */
export function parseAntigravityTranscript(text: string, opts: ParseOptions): NirSession | null {
  const id =
    opts.id ??
    (opts.filePath?.includes("/brain/")
      ? (opts.filePath.split("/brain/")[1]?.split("/")[0] ?? opts.filePath)
      : opts.filePath);
  if (!id) throw new Error("parseAntigravityTranscript: opts.id or opts.filePath is required");
  const messages: NirMessage[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type as string | undefined;
    const ts =
      typeof row.created_at === "string"
        ? (Number.isNaN(new Date(row.created_at).getTime())
            ? row.created_at
            : new Date(row.created_at).toISOString())
        : null;
    const content = normalizeContent(row.content).slice(0, MAX_CONTENT);

    switch (type) {
      case "USER_INPUT": {
        const cleaned = extractUserRequest(content);
        if (cleaned) messages.push(makeMsg({ role: "user", content: cleaned, timestamp: ts }));
        break;
      }
      case "PLANNER_RESPONSE":
      case "CONVERSATION_HISTORY": {
        if (content) messages.push(makeMsg({ role: "assistant", content, timestamp: ts }));
        const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const c = tc as Record<string, unknown>;
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: typeof c.name === "string" ? c.name : "unknown",
              toolInput: (c.args as Record<string, unknown>) ?? null,
              timestamp: ts,
            }),
          );
        }
        break;
      }
      case "CODE_ACTION":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "edit",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "VIEW_FILE":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "read",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "RUN_COMMAND": {
        const cmd = extractString(row, "command") || content;
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "bash",
            toolInput: { command: cmd },
            timestamp: ts,
          }),
        );
        const output = extractString(row, "output");
        if (output) {
          messages.push(
            makeMsg({
              role: "tool",
              content: output.slice(0, MAX_CONTENT),
              toolName: "bash",
              timestamp: ts,
            }),
          );
        }
        break;
      }
      case "GREP_SEARCH":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "search",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "LIST_DIRECTORY":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "list",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      default:
        // Thinking/reasoning rows (if any) are dropped: the transcript format
        // gives no concrete type name for them to match on.
        break;
    }
  }

  if (messages.length === 0) return null;
  return buildSession({
    id,
    source: opts.source,
    projectPath: null,
    messages,
  });
}

// USER_INPUT rows wrap the real prompt in a <USER_REQUEST> tag with harness
// context around it; unwrap when present.
function extractUserRequest(content: string): string {
  if (!content) return "";
  const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return m?.[1] ? m[1].trim() : content.trim();
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

function extractString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function extractTarget(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["file_path", "filePath", "path", "target", "query", "directory"]) {
    const v = row[key];
    if (typeof v === "string") return { path: v };
  }
  return {};
}
