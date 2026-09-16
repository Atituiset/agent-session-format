import type { NirMessage, NirSession } from "../schema.js";
import type { SqliteDb } from "../sqlite.js";
import { buildSession, isoFromSecsOrMs, makeMsg, safeJsonParse } from "../util.js";

const MAX_TEXT = 30_000;

interface HermesToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  args?: Record<string, unknown>;
}

/**
 * Parse a legacy Hermes request dump (`request_dump_<sessionId>_*.json`): the
 * whole file is one API request whose `request.body.messages` is the
 * OpenAI-style conversation. All messages share the dump's timestamp.
 */
export function parseHermesDump(
  text: string,
  opts: { source: string; id: string },
): NirSession | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const body = ((data.request as Record<string, unknown> | undefined)?.body ??
    {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const timestamp = typeof data.timestamp === "string" ? data.timestamp : null;
  const messages: NirMessage[] = [];

  for (const rm of rawMessages) {
    if (!rm || typeof rm !== "object") continue;
    const msg = rm as { role?: string; content?: unknown; tool_calls?: HermesToolCall[] };
    const role = msg.role ?? "";
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const content = normalizeHermesContent(msg.content).slice(0, MAX_TEXT);
    if (role === "tool") {
      messages.push(makeMsg({ role: "tool", content, timestamp }));
      continue;
    }
    if (content) messages.push(makeMsg({ role, content, timestamp }));
    if (role === "assistant") {
      for (const tc of parseHermesToolCalls(msg.tool_calls)) {
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: tc.name,
            toolInput: tc.input,
            toolCallId: tc.id ?? null,
            timestamp,
          }),
        );
      }
    }
  }

  if (messages.length === 0) return null;
  return buildSession({ id: opts.id, source: opts.source, messages });
}

interface HermesSessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  started_at: number | null;
  cwd: string | null;
  model: string | null;
}

interface HermesMessageRow {
  role: string;
  content: unknown;
  tool_calls: string | null;
  tool_call_id: string | null;
  timestamp: number | null;
  reasoning_content: string | null;
}

/**
 * Map a newer Hermes `state.db` (sessions + messages tables) to NIR sessions,
 * via the injected `SqliteDb` interface.
 */
export async function hermesSessionsFromDb(
  db: SqliteDb,
  opts: { source: string },
): Promise<NirSession[]> {
  const rows = (await db
    .prepare(
      `SELECT id, title, display_name, started_at, cwd, model
       FROM sessions WHERE archived = 0 AND hidden = 0 ORDER BY started_at DESC`,
    )
    .all()) as HermesSessionRow[];
  const msgStmt = db.prepare(
    `SELECT role, content, tool_calls, tool_call_id, timestamp, reasoning_content
     FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp`,
  );

  const out: NirSession[] = [];
  for (const row of rows) {
    const msgRows = (await msgStmt.all(row.id)) as HermesMessageRow[];
    const messages: NirMessage[] = [];
    for (const mr of msgRows) {
      const role = mr.role;
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
      const ts = isoFromSecsOrMs(mr.timestamp);
      if (role === "tool") {
        messages.push(
          makeMsg({
            role: "tool",
            content: normalizeHermesContent(mr.content).slice(0, MAX_TEXT),
            toolCallId: mr.tool_call_id || null,
            timestamp: ts,
          }),
        );
        continue;
      }
      const thinking = typeof mr.reasoning_content === "string" ? mr.reasoning_content : "";
      if (thinking.trim()) {
        messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts }));
      }
      const content = normalizeHermesContent(mr.content).slice(0, MAX_TEXT);
      if (content) messages.push(makeMsg({ role, content, timestamp: ts }));
      let calls: HermesToolCall[] = [];
      if (typeof mr.tool_calls === "string" && mr.tool_calls) {
        const parsed = safeJsonParse(mr.tool_calls);
        if (Array.isArray(parsed)) calls = parsed as HermesToolCall[];
      }
      for (const tc of parseHermesToolCalls(calls)) {
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: tc.name,
            toolInput: tc.input,
            toolCallId: tc.id ?? null,
            timestamp: ts,
          }),
        );
      }
    }
    if (messages.length === 0) continue;
    out.push(
      buildSession({
        id: row.id,
        source: opts.source,
        title: row.display_name || row.title,
        model: row.model,
        projectPath: row.cwd,
        startedAt: isoFromSecsOrMs(row.started_at),
        messages,
      }),
    );
  }
  return out;
}

function parseHermesToolCalls(raw: HermesToolCall[] | undefined): { id?: string; name: string; input: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc) => ({
    ...(tc.id ? { id: tc.id } : {}),
    name: tc.function?.name || tc.name || "unknown",
    input: (() => {
      try {
        return JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
      } catch {
        return tc.args || {};
      }
    })(),
  }));
}

function normalizeHermesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return (p as { text?: string }).text || JSON.stringify(p);
        return "";
      })
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}
