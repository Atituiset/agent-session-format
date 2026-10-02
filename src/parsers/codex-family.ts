import type { NirMessage, NirSession, NirToolResult } from "../schema.js";
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
import type { ExtractedTokens } from "../util.js";
import type { ParseOptions } from "./claude-code.js";

export interface KimiWireOptions extends ParseOptions {
  /** Agent lane name; overrides the `agents/<name>` path segment when set. */
  agent?: string;
  /** Human-readable lane label recorded as `agentLabel` on subagent messages. */
  agentLabel?: string;
}

/**
 * Parse a Codex CLI rollout `.jsonl` (also used by DeepSeek and other
 * Responses-API-style event streams). Handles both the real
 * `{type:"response_item", payload}` envelope and the older flat
 * `{type:"message", payload:{role, content}}` shape.
 */
/**
 * Codex / Kimi verdict extraction.
 *
 * An earlier version of this file claimed codex exposes NO verdict because the
 * `function_call_output` payload has only {type, call_id, output}. That was wrong:
 * the payload KEYS are sparse, but the `output` STRING carries codex's own
 * machine-generated envelope, in one of several fixed shapes:
 *
 *   Exit code: 0\nWall time: 0.3 seconds\nOutput:\n…
 *   …chunk-id 4d2f3\nWall time: 0.1356 seconds\nProcess exited with code 0\nOriginal token count: 340\nOutput:\n…
 *
 * Measured over 4439 real `function_call_output` payloads: "Exit code: N" appears
 * 603 times, "exited with code N" 2615 times, "process exited with" 2610 times.
 * These are formats, not agent prose — unlike opencode/claude, where regexing
 * arbitrary content was measured at a ~100% false-positive rate (234 flagged
 * sessions, 0 confirmed). Matching a machine envelope is exact; matching prose is
 * not.
 *
 * So this is `method: "derived"`: stronger than a content guess because the
 * envelope is machine-written, weaker than a real field because it is parsed from
 * a string. Real-world coverage on the codex corpus: 72.7% of tool results, with
 * 183 real errors and 0 exit-code/status mismatches on spot check.
 */
function codexVerdict(output: string): NirToolResult | undefined {
  if (output === "") return undefined;
  // Prefer the most specific machine envelope. `Exit code:` is codex's newer
  // unified exec envelope; `Process exited with code` is the older one.
  const newer = /Exit code: (\d+)/.exec(output);
  if (newer) {
    const code = Number(newer[1]);
    return {
      status: code === 0 ? "success" : "error",
      method: "derived",
      errorText: code === 0 ? null : excerpt(output, newer.index),
      detail: { exitCode: code, envelope: "exit_code" },
    };
  }
  const older = /Process exited with code (\d+)/i.exec(output);
  if (older) {
    const code = Number(older[1]);
    return {
      status: code === 0 ? "success" : "error",
      method: "derived",
      errorText: code === 0 ? null : excerpt(output, older.index),
      detail: { exitCode: code, envelope: "process_exited" },
    };
  }
  // Third shape, seen on npm/pnpm failures — also machine-written.
  const failed = /Command failed with exit code (\d+)/i.exec(output);
  if (failed) {
    const code = Number(failed[1]);
    return {
      status: "error",
      method: "derived",
      errorText: excerpt(output, failed.index),
      detail: { exitCode: code, envelope: "command_failed" },
    };
  }
  return undefined;
}

/** Keep a short window around the marker so a human can audit the verdict. */
function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + 120);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/**
 * Kimi task verdict — the richest signal any source exposes.
 *
 * Measured vocabulary across 683 real task records:
 *   completed 522 | killed 85 | failed 44 | timed_out 18 | lost 11 | running 3
 * with 577 carrying an `exitCode` (108 of them non-zero) and 99 a `stopReason`
 * (a readable reason such as "curl 挂起,改用 python 获取").
 *
 * Mapping notes:
 * - `completed` is only success when `exitCode` is 0 or absent. A command can
 *   complete and still have failed.
 * - `timed_out` maps to `cancelled` rather than `error`: the command did not
 *   report failure, it was cut off. Collapsing the two would invent failures.
 * - `lost` and `killed` are both errors but are NOT the same event — an agent
 *   that killed a runaway curl is behaving differently from one whose command
 *   died. The distinction is preserved in `detail.status`.
 */
function kimiTaskVerdict(info: Record<string, unknown>): NirToolResult | undefined {
  const status = typeof info.status === "string" ? info.status : null;
  if (status === null) return undefined;
  const exitCode = typeof info.exitCode === "number" ? info.exitCode : undefined;
  const stopReason = typeof info.stopReason === "string" ? info.stopReason : null;

  let verdict: "success" | "error" | "cancelled" | "unknown";
  if (status === "running") verdict = "unknown";
  else if (status === "timed_out") verdict = "cancelled";
  else if (status === "completed") {
    verdict = exitCode === undefined || exitCode === 0 ? "success" : "error";
  } else verdict = "error"; // failed | killed | lost

  return {
    status: verdict,
    // source-reported: this is a field in the event, not parsed from prose.
    method: "source_status",
    errorText: verdict === "success" ? null : JSON.stringify(pickErrorBits(info)).slice(0, 300),
    detail: {
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(stopReason !== null ? { stopReason } : {}),
      ...(typeof info.kind === "string" ? { kind: info.kind } : {}),
      ...(typeof info.detached === "boolean" ? { detached: info.detached } : {}),
    },
  };
}

/** The fields worth keeping in the error evidence, not the whole record. */
function pickErrorBits(info: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (info.status !== undefined) out.status = info.status;
  if (info.exitCode !== undefined) out.exitCode = info.exitCode;
  if (info.stopReason !== undefined) out.stopReason = info.stopReason;
  if (info.taskId !== undefined) out.taskId = info.taskId;
  return out;
}

/** Human-readable one-liner standing in for a task's (separate) output log. */
function kimiTaskText(info: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof info.status === "string") bits.push(`task ${info.status}`);
  if (typeof info.exitCode === "number") bits.push(`exit ${info.exitCode}`);
  if (typeof info.stopReason === "string") bits.push(info.stopReason);
  if (typeof info.command === "string") bits.push(`\n$ ${info.command.slice(0, 400)}`);
  return bits.join(" ");
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
  // token_count events carry a cumulative snapshot; only the latest matters.
  let latestUsage: ExtractedTokens | undefined;

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
    if (row.type === "event_msg") {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (p.type === "token_count") {
        const info = (p.info ?? {}) as Record<string, unknown>;
        const u = extractTokens(info.total_token_usage);
        if (u) latestUsage = u;
      }
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
      const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null);
      const verdict = codexVerdict(output);
      messages.push(
        makeMsg({
          role: "tool",
          content: output,
          toolName: callName(messages, p.call_id),
          toolCallId: typeof p.call_id === "string" ? p.call_id : null,
          timestamp: ts,
          ...(verdict ? { toolResult: verdict } : {}),
        }),
      );
    }
  }

  if (messages.length === 0) return null;
  if (!id) throw new Error("parseCodexRollout: opts.id, opts.filePath, or a session_meta row is required");
  const session = buildSession({
    id,
    source: opts.source,
    sourceVersion,
    model,
    projectPath,
    messages,
    ...(latestUsage ? { tokens: latestUsage } : {}),
    rawMeta: patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {},
  });
  if (latestUsage) {
    // Session totals ride on the last assistant message so consumers summing
    // per-message tokens land on the same figure.
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = latestUsage;
  }
  return session;
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
  const tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let durationMs: number | undefined;
  const lane =
    agentName === "main"
      ? {}
      : { agent: agentName, ...(opts.agentLabel ? { agentLabel: opts.agentLabel } : {}) };

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
      case "task.terminated": {
        // Kimi reports EVERY background/detached command's verdict inline, as a
        // `task.terminated` event carrying the full task info object:
        //   {taskId, status: completed|killed|failed|timed_out|lost|running,
        //    exitCode, stopReason, command, startedAt, endedAt}
        //
        // 0.5.0 recorded kimi as signal-free and 0.6.0 only tried codex's exec
        // envelopes. Both were wrong: this event was in the file the parser
        // already reads. Measured across 683 real task records the status
        // vocabulary is completed 522 / killed 85 / failed 44 / timed_out 18 /
        // lost 11, with 108 non-zero exit codes — richer than any other source.
        //
        // It is emitted as a `tool` message keyed by taskId so it pairs with the
        // `tool.call` that started it, which is how a consumer learns that a
        // detached command finished (and how it went).
        const info = row.info as Record<string, unknown> | undefined;
        if (info && typeof info === "object") {
          const taskId = typeof info.taskId === "string" ? info.taskId : null;
          messages.push(
            makeMsg({
              role: "tool",
              content: kimiTaskText(info),
              toolName: info.kind === "agent" ? "task" : "bash",
              toolCallId: taskId,
              timestamp: isoFromSecsOrMs(info.endedAt),
              ...(() => {
                const v = kimiTaskVerdict(info);
                return v ? { toolResult: v } : {};
              })(),
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
          const resultText = extractToolResultText(e.result);
          // Kimi shares codex's exec envelopes (it uses the same wire family),
          // so the same machine-written verdict markers apply. Measured on the
          // codex corpus these cover ~73% of tool results; kimi is the second
          // largest population in the local store, so this is where the outcome
          // blind spot actually lives.
          const verdict = codexVerdict(resultText);
          messages.push(
            makeMsg({
              role: "tool",
              content: resultText,
              toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : null,
              timestamp: ts,
              ...(verdict ? { toolResult: verdict } : {}),
              ...lane,
            }),
          );
        }
        break;
      }
      case "usage.record": {
        // usageScope:"turn" — per-turn, safe to sum. (meta.usage echoes the
        // same turn record on messages; do NOT read those or we'd double count.)
        const u = extractTokens(row.usage ?? row);
        if (u) {
          tokenTotals.input += u.input;
          tokenTotals.output += u.output;
          tokenTotals.cacheRead += u.cacheRead;
          tokenTotals.cacheWrite += u.cacheWrite;
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
  const hasTokens =
    tokenTotals.input + tokenTotals.output + tokenTotals.cacheRead + tokenTotals.cacheWrite > 0;
  const session = buildSession({
    id,
    source: opts.source,
    model,
    projectPath: null,
    startedAt: isoFromSecsOrMs(startedAtMs),
    messages,
    ...(hasTokens ? { tokens: { ...tokenTotals } } : {}),
    rawMeta,
  });
  if (hasTokens) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = { ...tokenTotals };
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
          content,
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
              content: out,
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
