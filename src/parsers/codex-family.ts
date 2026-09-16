import type { NirMessage, NirSession } from "../schema.js";
import {
  basenameNoExt,
  buildSession,
  collectPatchFiles,
  estTokens,
  extractTokens,
  flattenContent,
  isoFromSecsOrMs,
  makeMsg,
  safeJsonParse,
} from "../util.js";
import type { ParseOptions } from "./claude-code.js";

const MAX_TOOL_CONTENT = 20_000;

export interface KimiWireOptions extends ParseOptions {
  /** Agent lane name; overrides the `agents/<name>` path segment when set. */
  agent?: string;
}

/**
 * Parse a Codex CLI rollout `.jsonl` (also used by DeepSeek and other
 * Responses-API-style event streams). Handles both the real
 * `{type:"response_item", payload}` envelope and the older flat
 * `{type:"message", payload:{role, content}}` shape.
 */
export function parseCodexRollout(text: string, opts: ParseOptions): NirSession | null {
  let id = opts.id ?? (opts.filePath ? basenameNoExt(opts.filePath, ".jsonl") : undefined);
  let projectPath: string | null = null;
  let sourceVersion: string | null = null;
  let model: string | null = null;
  const messages: NirMessage[] = [];
  const patchFiles = new Set<string>();

  const pushMessage = (p: Record<string, unknown>, ts: string | null) => {
    const role = p.role as string;
    // developer-injected instructions are not conversation.
    if (role !== "user" && role !== "assistant" && role !== "system") return;
    const content = flattenContent(p.content).text;
    if (!content) return;
    // The first user item in real rollouts is an <environment_context> blob.
    if (role === "user" && /^<environment_context>[\s\S]*<\/environment_context>$/.test(content.trim())) {
      return;
    }
    messages.push(makeMsg({ role, content, timestamp: ts, model }));
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    if (row.type === "session_meta") {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") projectPath = p.cwd;
      if (typeof p.cli_version === "string") sourceVersion = p.cli_version;
      continue;
    }
    if (row.type === "turn_context") {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (row.type === "message") {
      // Older flat shape: {type:"message", payload:{role, content}}.
      const p = (row.payload && typeof row.payload === "object" ? row.payload : row) as Record<string, unknown>;
      pushMessage(p, ts);
      continue;
    }
    if (row.type !== "response_item") continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const pt = p.type as string | undefined;
    if (pt === "message") {
      pushMessage(p, ts);
    } else if (pt === "reasoning") {
      // Encrypted reasoning without a summary carries no text and yields nothing.
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const thinking = summary
        .map((s) =>
          s && typeof s === "object" ? String((s as Record<string, unknown>).text ?? "") : "",
        )
        .filter((t) => t.length > 0)
        .join("\n")
        .trim();
      if (thinking) {
        messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model }));
      }
    } else if (pt === "function_call" || pt === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "unknown";
      const rawArgs = (p.arguments ?? p.input) as unknown;
      const input =
        typeof rawArgs === "string"
          ? (safeJsonParse(rawArgs) ?? { raw: rawArgs })
          : (rawArgs ?? null);
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: name,
          toolInput: input,
          toolCallId: typeof p.call_id === "string" ? p.call_id : null,
          timestamp: ts,
          model,
        }),
      );
      if (name === "apply_patch" && typeof rawArgs === "string") {
        collectPatchFiles(rawArgs, patchFiles);
      }
    } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
      const output =
        typeof p.output === "string"
          ? p.output.slice(0, MAX_TOOL_CONTENT)
          : JSON.stringify(p.output ?? null);
      messages.push(
        makeMsg({
          role: "tool",
          content: output,
          toolName: callName(messages, p.call_id),
          toolCallId: typeof p.call_id === "string" ? p.call_id : null,
          timestamp: ts,
        }),
      );
    }
  }

  if (messages.length === 0) return null;
  if (!id) throw new Error("parseCodexRollout: opts.id, opts.filePath, or a session_meta row is required");
  return buildSession({
    id,
    source: opts.source,
    sourceVersion,
    model,
    projectPath,
    messages,
    rawMeta: patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {},
  });
}

/**
 * Parse one Kimi Code `wire.jsonl` event stream. Handles both event styles:
 * - `context.append_message` rows carrying full message objects (with
 *   `toolCalls`), `profile.bind`, `usage.record`, `turn.ended`;
 * - `context.append_loop_event` rows (`content.part` / `tool.call` /
 *   `tool.result`) from newer runtimes.
 */
export function parseKimiWire(text: string, opts: KimiWireOptions): NirSession | null {
  let sessionDir = "";
  let workspaceDir = "";
  let agentFromPath = "main";
  if (opts.filePath) {
    const parts = opts.filePath.split("/");
    sessionDir = parts.find((p) => p.startsWith("session_")) ?? "";
    workspaceDir = parts.find((p) => p.startsWith("wd_")) ?? "";
    const agentsIdx = parts.indexOf("agents");
    agentFromPath = agentsIdx >= 0 ? (parts[agentsIdx + 1] ?? "main") : "main";
  }
  const agentName = opts.agent ?? agentFromPath;
  const id =
    opts.id ??
    (opts.filePath
      ? `${sessionDir.replace(/^session_/, "") || opts.filePath}/${agentName}`
      : undefined);
  const projectHint = workspaceDir.replace(/^wd_/, "").replace(/_[0-9a-f]+$/, "");
  let model: string | null = null;
  let startedAtMs: number | undefined;
  const messages: NirMessage[] = [];
  const tokenTotals = { input: 0, output: 0 };
  let durationMs: number | undefined;
  const lane = agentName === "main" ? {} : { agent: agentName };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof row.time === "number" ? row.time : undefined;
    if (t && startedAtMs === undefined) startedAtMs = t;
    const ts = isoFromSecsOrMs(t);
    switch (row.type) {
      case "profile.bind": {
        if (typeof row.modelAlias === "string") model = row.modelAlias;
        break;
      }
      case "context.append_message": {
        const m = (row.message ?? {}) as Record<string, unknown>;
        const role = m.role as string;
        if (role !== "user" && role !== "assistant" && role !== "system") break;
        const { text, thinking } = flattenContent(m.content);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (thinking) {
          messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model, ...lane }));
        }
        if (text) {
          messages.push(makeMsg({ role, content: text, timestamp: ts, model, ...lane }));
        }
        for (const tc of calls) {
          const c = tc as Record<string, unknown>;
          const argsRaw = c.arguments ?? c.input ?? c.args;
          const parsed =
            typeof argsRaw === "string"
              ? (safeJsonParse(argsRaw) ?? { raw: argsRaw })
              : (argsRaw ?? null);
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: (c.name as string) ?? (c.toolName as string) ?? "unknown",
              toolInput: parsed,
              toolCallId: typeof c.id === "string" ? c.id : null,
              timestamp: ts,
              model,
              ...lane,
            }),
          );
        }
        break;
      }
      case "context.append_loop_event": {
        const e = (row.event ?? {}) as Record<string, unknown>;
        if (e.type === "content.part") {
          const part = (e.part ?? {}) as { type?: string; text?: string; think?: string };
          if (part.type === "think" && part.think?.trim()) {
            messages.push(
              makeMsg({ role: "assistant", content: "", thinking: part.think, timestamp: ts, model, ...lane }),
            );
          } else if (part.type === "text" && part.text?.trim()) {
            messages.push(
              makeMsg({ role: "assistant", content: part.text, timestamp: ts, model, ...lane }),
            );
          }
        } else if (e.type === "tool.call") {
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: (e.name as string) || "unknown",
              toolInput: (e.args as Record<string, unknown>) ?? null,
              toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : null,
              timestamp: ts,
              model,
              ...lane,
            }),
          );
        } else if (e.type === "tool.result") {
          messages.push(
            makeMsg({
              role: "tool",
              content: extractToolResultText(e.result).slice(0, MAX_TOOL_CONTENT),
              toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : null,
              timestamp: ts,
              ...lane,
            }),
          );
        }
        break;
      }
      case "usage.record": {
        const u = extractTokens(row.usage ?? row);
        if (u) {
          tokenTotals.input += u.input;
          tokenTotals.output += u.output;
        }
        break;
      }
      case "turn.ended": {
        if (typeof row.durationMs === "number") durationMs = (durationMs ?? 0) + row.durationMs;
        break;
      }
    }
  }

  if (messages.length === 0) return null;
  if (!id) throw new Error("parseKimiWire: opts.id or opts.filePath is required");
  // Estimated tokens must NOT be attached as message.tokens — consumers would
  // misreport them as "reported" usage. Keep the estimate in rawMeta instead.
  const rawMeta: Record<string, unknown> = projectHint
    ? { projectHint, agent: agentName }
    : { agent: agentName };
  if (durationMs !== undefined) rawMeta.durationMs = durationMs;
  rawMeta.estimatedTokens = messages.reduce((sum, m) => sum + estTokens(m.content), 0);
  const hasTokens = tokenTotals.input + tokenTotals.output > 0;
  const session = buildSession({
    id,
    source: opts.source,
    model,
    projectPath: null,
    startedAt: isoFromSecsOrMs(startedAtMs),
    messages,
    ...(hasTokens ? { tokens: { ...tokenTotals, cacheRead: 0, cacheWrite: 0 } } : {}),
    rawMeta,
  });
  if (hasTokens) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = { ...tokenTotals, cacheRead: 0, cacheWrite: 0 };
  }
  return session;
}

/**
 * Parse a single-file JSON session document
 * `{ metadata?, messages: [{ role, content, tool_calls? }] }` — the shape used
 * by codewhale, DeepSeek, and similar OpenAI-style dumps.
 */
export function parseSessionJsonDocument(text: string, opts: ParseOptions): NirSession | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const meta = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
  const id =
    opts.id ??
    firstString(meta, ["id", "session_id"]) ??
    (opts.filePath ? basenameNoExt(opts.filePath, ".json") : undefined);
  if (!id) throw new Error("parseSessionJsonDocument: opts.id, metadata.id, or opts.filePath is required");
  const projectPath =
    firstString(meta, ["cwd", "workdir", "working_directory", "project_path", "workspace", "path"]) ?? null;
  const model = firstString(meta, ["model", "model_id"]) ?? null;
  const title = firstString(meta, ["title"]) ?? null;
  const createdAt = typeof meta.created_at === "string" ? meta.created_at : null;
  const rawMessages = Array.isArray(doc.messages) ? doc.messages : [];
  const messages: NirMessage[] = [];

  for (const rm of rawMessages) {
    if (!rm || typeof rm !== "object") continue;
    const m = rm as Record<string, unknown>;
    const role = m.role as string;
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    const ts = isoFromSecsOrMs(m.timestamp) ?? createdAt;
    if (role === "tool") {
      // OpenAI-style tool result message.
      const { text: out } = flattenContent(m.content);
      const content = out || (m.content === undefined || m.content === null ? "" : JSON.stringify(m.content));
      messages.push(
        makeMsg({
          role: "tool",
          content: content.slice(0, MAX_TOOL_CONTENT),
          toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : null,
          timestamp: ts,
        }),
      );
      continue;
    }
    const { text, thinking } = flattenContent(m.content);
    if (thinking) {
      messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model }));
    }
    if (text) {
      messages.push(makeMsg({ role, content: text, timestamp: ts, model }));
    }
    // Claude-style tool_use / tool_result blocks inside the content array.
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: typeof b.name === "string" ? b.name : "unknown",
              toolInput: b.input ?? null,
              toolCallId: typeof b.id === "string" ? b.id : null,
              timestamp: ts,
              model,
            }),
          );
        } else if (b.type === "tool_result") {
          const inner = b.content;
          const out =
            typeof inner === "string"
              ? inner
              : Array.isArray(inner)
                ? inner
                    .map((x) =>
                      x && typeof x === "object" && (x as Record<string, unknown>).type === "text"
                        ? String((x as Record<string, unknown>).text ?? "")
                        : "",
                    )
                    .join("\n")
                : "";
          messages.push(
            makeMsg({
              role: "tool",
              content: out.slice(0, MAX_TOOL_CONTENT),
              toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
              timestamp: ts,
            }),
          );
        }
      }
    }
    // OpenAI-style tool_calls attached to an assistant message.
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const c = tc as Record<string, unknown>;
      const fn = (c.function && typeof c.function === "object" ? c.function : c) as Record<string, unknown>;
      const argsRaw = fn.arguments ?? c.args;
      const parsed =
        typeof argsRaw === "string"
          ? (safeJsonParse(argsRaw) ?? { raw: argsRaw })
          : (argsRaw ?? null);
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: (fn.name as string) ?? (c.name as string) ?? "unknown",
          toolInput: parsed,
          toolCallId: typeof c.id === "string" ? c.id : null,
          timestamp: ts,
          model,
        }),
      );
    }
  }

  if (messages.length === 0) return null;
  return buildSession({
    id,
    source: opts.source,
    title,
    model,
    projectPath,
    messages,
  });
}

/** Backwards-compatible alias: codewhale files are session-JSON documents. */
export const parseCodewhaleSession = parseSessionJsonDocument;

function callName(messages: NirMessage[], callId: unknown): string | null {
  if (typeof callId !== "string") return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" && m.toolName) {
      if (m.toolCallId === callId || !m.toolCallId) return m.toolName;
    }
  }
  return null;
}

function extractToolResultText(result: unknown): string {
  if (result && typeof result === "object") {
    const output = (result as { output?: unknown }).output;
    if (typeof output === "string") return output;
    if (output !== undefined) return JSON.stringify(output);
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
