import type { NirSession } from "./schema.js";
import { makeMsg, buildSession } from "./util.js";
import { parseClaudeCodeTranscript, type ParseOptions } from "./parsers/claude-code.js";
import { parseCodexRollout, parseSessionJsonDocument } from "./parsers/codex-family.js";

/**
 * Content classification for arbitrary transcript text — the heuristics behind
 * agent-viewer's self-discovery of unknown agents. CLI agent session storage
 * converges on a few shapes:
 * - claude-style:   JSONL of {type:"user"|"assistant", message:{...}, timestamp}
 * - codex-style:    JSONL of {type:"response_item", payload:{...}} rollout events
 * - chat-style:     JSONL of bare {role, content} rows (plainest dump)
 * - session-style:  one JSON document {metadata?, messages:[{role, content}]}
 */
export type GenericKind = "claude-style" | "codex-style" | "chat-style" | "session-style";

/**
 * Classify a text sample (a whole file or a truncated head — e.g. the first
 * few KB). Returns null when nothing matches.
 *
 * Note the sample may be truncated mid-JSON: JSONL shapes are detected line by
 * line; session-style single-file JSON necessarily fails JSON.parse when cut,
 * so it is recognized by its key-sequence fingerprint instead.
 */
export function detectKind(sample: string): GenericKind | null {
  const head = sample.slice(0, 64 * 1024);
  const session = detectSessionStyle(head);
  if (session) return session;
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // corrupt line / truncated tail — try the next one
    }
    if (obj.type === "response_item" || (obj.payload && typeof obj.payload === "object")) return "codex-style";
    if ((obj.type === "user" || obj.type === "assistant") && obj.message) return "claude-style";
    if (typeof obj.role === "string" && obj.content !== undefined) return "chat-style";
    return null; // valid JSON but an unrecognized shape
  }
  return null;
}

/**
 * session-style detection: a complete single-file JSON conversation
 * (messages: [{role, content}]), or a truncated fragment of one. The fragment
 * can never JSON.parse, so it is matched on the fingerprint
 *   {"...": ..., "messages": [...{"role": "...", "content": ...
 * — "messages" followed by an object member containing "role". Specific enough
 * not to misfire on config files (no "messages"+"role" combination).
 */
function detectSessionStyle(sample: string): GenericKind | null {
  const trimmed = sample.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(sample) as Record<string, unknown>;
    if (isSessionShapedObject(obj)) return "session-style";
    return null;
  } catch {
    const messagesIdx = trimmed.indexOf('"messages"');
    if (messagesIdx < 0) return null;
    const after = trimmed.slice(messagesIdx);
    if (after.indexOf('"role"') < 0) return null;
    if (after.indexOf('"content"') < 0) return null;
    return "session-style";
  }
}

function isSessionShapedObject(obj: Record<string, unknown>): boolean {
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0] as Record<string, unknown> | null;
  return !!first && typeof first === "object" && typeof first.role === "string" && first.content !== undefined;
}

/**
 * Parse a chat-style transcript: one bare {role, content[, timestamp]} JSON
 * object per line, line-fault-tolerant.
 */
export function parseChatTranscript(text: string, opts: ParseOptions & { id: string }): NirSession | null {
  const messages = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = obj.role;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
    const content =
      typeof obj.content === "string" ? obj.content : obj.content === undefined ? "" : JSON.stringify(obj.content);
    if (!content) continue;
    let timestamp: string | null = null;
    if (obj.timestamp !== undefined) {
      const d = new Date(obj.timestamp as string);
      timestamp = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    messages.push(makeMsg({ role, content, timestamp }));
  }
  if (messages.length === 0) return null;
  return buildSession({ id: opts.id, source: opts.source, messages });
}

/**
 * Dispatch to the matching family parser for a detected kind. All four kinds
 * map onto the same family parsers used for known tools.
 */
export function parseDetectedTranscript(
  kind: GenericKind,
  text: string,
  opts: ParseOptions & { id?: string },
): NirSession | null {
  switch (kind) {
    case "claude-style":
      return parseClaudeCodeTranscript(text, opts);
    case "codex-style":
      return parseCodexRollout(text, opts);
    case "session-style":
      return parseSessionJsonDocument(text, opts);
    case "chat-style": {
      const id = opts.id ?? (opts.filePath ? opts.filePath.replace(/\.(jsonl|json)$/i, "") : undefined);
      if (!id) throw new Error("parseDetectedTranscript(chat-style): opts.id or opts.filePath is required");
      return parseChatTranscript(text, { ...opts, id });
    }
  }
}
