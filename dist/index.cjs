"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  buildSession: () => buildSession,
  collectPatchFiles: () => collectPatchFiles,
  decodeClaudeProjectSlug: () => decodeClaudeProjectSlug,
  detectKind: () => detectKind,
  estTokens: () => estTokens,
  extractTokens: () => extractTokens,
  flattenContent: () => flattenContent,
  hermesSessionFromDb: () => hermesSessionFromDb,
  hermesSessionsFromDb: () => hermesSessionsFromDb,
  isoFromMs: () => isoFromMs,
  isoFromSecsOrMs: () => isoFromSecsOrMs,
  makeMsg: () => makeMsg,
  makeNirSession: () => makeNirSession,
  nirMessageSchema: () => nirMessageSchema,
  nirRoleSchema: () => nirRoleSchema,
  nirSessionSchema: () => nirSessionSchema,
  nirTokenUsageSchema: () => nirTokenUsageSchema,
  nirToolResultSchema: () => nirToolResultSchema,
  opencodeSessionFromDb: () => opencodeSessionFromDb,
  opencodeSessionsFromDb: () => opencodeSessionsFromDb,
  parseAntigravityTranscript: () => parseAntigravityTranscript,
  parseChatTranscript: () => parseChatTranscript,
  parseClaudeCodeTranscript: () => parseClaudeCodeTranscript,
  parseCodewhaleSession: () => parseCodewhaleSession,
  parseCodexRollout: () => parseCodexRollout,
  parseDetectedTranscript: () => parseDetectedTranscript,
  parseHermesDump: () => parseHermesDump,
  parseKimiWire: () => parseKimiWire,
  parseSessionJsonDocument: () => parseSessionJsonDocument,
  safeJsonParse: () => safeJsonParse
});
module.exports = __toCommonJS(src_exports);

// src/schema.ts
var import_zod = require("zod");
var nirRoleSchema = import_zod.z.enum(["user", "assistant", "tool", "system"]);
var nirToolResultSchema = import_zod.z.object({
  status: import_zod.z.enum(["success", "error", "cancelled", "unknown"]),
  /**
   * `source_is_error`   — claude `tool_result.is_error`
   * `source_status`     — opencode/antigravity part state status
   * `source_error_text` — opencode `state.error` carried over verbatim
   * `derived`           — inferred from output text (last resort, see `detail`)
   */
  method: import_zod.z.enum(["source_is_error", "source_status", "derived"]),
  /** Verbatim provider error text, when the source exposed one. */
  errorText: import_zod.z.string().nullable().default(null),
  /** Provider-specific extras (exit code, background-task flag), when present. */
  detail: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).default({})
});
var nirTokenUsageSchema = import_zod.z.object({
  input: import_zod.z.number().int().nonnegative().default(0),
  output: import_zod.z.number().int().nonnegative().default(0),
  cacheRead: import_zod.z.number().int().nonnegative().default(0),
  cacheWrite: import_zod.z.number().int().nonnegative().default(0)
});
var nirMessageSchema = import_zod.z.object({
  role: nirRoleSchema,
  content: import_zod.z.string(),
  timestamp: import_zod.z.string().nullable(),
  toolName: import_zod.z.string().nullable(),
  toolInput: import_zod.z.unknown(),
  // Tool-call correlation id (Claude `tool_use.id`, Codex `call_id`, OpenAI
  // `tool_calls[].id`). Set on both the assistant tool-call message and the
  // tool-result message so consumers can pair them.
  toolCallId: import_zod.z.string().nullable().default(null),
  model: import_zod.z.string().nullable(),
  thinking: import_zod.z.string().nullable().default(null),
  tokens: nirTokenUsageSchema.optional(),
  // Structured tool outcome, set ONLY on `role: "tool"` messages and ONLY when
  // the source format provided a signal. Absent means "the source said nothing",
  // which is NOT the same as `status: "unknown"`.
  toolResult: nirToolResultSchema.optional(),
  // Swimlane id for subagent messages; absent/null means the main lane.
  agent: import_zod.z.string().nullable().default(null),
  agentLabel: import_zod.z.string().nullable().default(null)
});
var nirSessionSchema = import_zod.z.object({
  id: import_zod.z.string().min(1),
  source: import_zod.z.string().min(1),
  sourceVersion: import_zod.z.string().nullable(),
  title: import_zod.z.string().nullable().default(null),
  model: import_zod.z.string().nullable().default(null),
  cost: import_zod.z.number().nullable().default(null),
  projectPath: import_zod.z.string().nullable(),
  startedAt: import_zod.z.string().nullable(),
  endedAt: import_zod.z.string().nullable(),
  // Session-level token totals when the source reports them (opencode rows,
  // accumulated Claude/Kimi usage). Per-message `tokens` may still differ.
  tokens: nirTokenUsageSchema.optional(),
  messages: import_zod.z.array(nirMessageSchema).min(1),
  rawMeta: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).default({})
});
function makeNirSession(input) {
  return nirSessionSchema.parse(input);
}

// src/util.ts
function isoFromMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}
function isoFromSecsOrMs(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v < 1e12 ? v * 1e3 : v).toISOString() : null;
}
function estTokens(text) {
  return Math.ceil(text.length / 4);
}
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function collectPatchFiles(patch, out) {
  const re = /\*\*\* (Update|Add|Delete) File: (.+)/g;
  for (const m of patch.matchAll(re)) {
    const name = m[2];
    if (name) out.add(name.trim());
  }
}
function makeMsg(partial) {
  return {
    ...partial,
    content: partial.content ?? "",
    timestamp: partial.timestamp ?? null,
    toolName: partial.toolName ?? null,
    toolInput: partial.toolInput ?? null,
    toolCallId: partial.toolCallId ?? null,
    model: partial.model ?? null,
    thinking: partial.thinking ?? null,
    agent: partial.agent ?? null,
    agentLabel: partial.agentLabel ?? null
  };
}
function buildSession(partial) {
  const times = partial.messages.map((m) => m.timestamp).filter((t) => typeof t === "string");
  const sorted = [...times].sort();
  return {
    id: partial.id,
    source: partial.source,
    sourceVersion: partial.sourceVersion ?? null,
    title: partial.title ?? null,
    model: partial.model ?? null,
    cost: partial.cost ?? null,
    projectPath: partial.projectPath ?? null,
    startedAt: partial.startedAt ?? sorted[0] ?? null,
    endedAt: partial.endedAt ?? sorted[sorted.length - 1] ?? null,
    ...partial.tokens ? { tokens: partial.tokens } : {},
    messages: partial.messages,
    rawMeta: partial.rawMeta ?? {}
  };
}
function extractTokens(obj) {
  if (typeof obj !== "object" || obj === null) return void 0;
  const o = obj;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  const cacheObj = typeof o.cache === "object" && o.cache !== null ? o.cache : void 0;
  const cacheRead = pick("cached_input_tokens", "cache_read_input_tokens", "inputCacheRead", "cacheRead") + (typeof cacheObj?.read === "number" ? cacheObj.read : 0);
  const cacheWrite = pick("cache_write_input_tokens", "cache_creation_input_tokens", "inputCacheCreation", "cacheWrite") + (typeof cacheObj?.write === "number" ? cacheObj.write : 0);
  if (o.input_tokens !== void 0 || o.output_tokens !== void 0 || o.prompt_tokens !== void 0 || o.completion_tokens !== void 0) {
    const rawIn = pick("input_tokens", "prompt_tokens");
    const inclusive = o.cached_input_tokens !== void 0 || o.cache_write_input_tokens !== void 0;
    return {
      input: inclusive ? Math.max(0, rawIn - cacheRead - cacheWrite) : rawIn,
      output: pick("output_tokens", "completion_tokens"),
      cacheRead,
      cacheWrite
    };
  }
  if (o.input !== void 0 || o.output !== void 0 || o.inputOther !== void 0) {
    return {
      input: pick("input", "inputs", "inputOther"),
      // opencode reports reasoning separately; providers bill it as output.
      output: pick("output", "outputs") + pick("reasoning"),
      cacheRead,
      cacheWrite
    };
  }
  if (cacheRead + cacheWrite > 0) {
    return { input: 0, output: 0, cacheRead, cacheWrite };
  }
  return void 0;
}
function flattenContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return flattenContent([content]);
  }
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const out = [];
  const thoughts = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      const b = block;
      if (b.type === "text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "input_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "output_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "summary_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
      else if (b.type === "think" && typeof b.think === "string") thoughts.push(b.think);
      else if (b.type === "reasoning") {
        const t = typeof b.text === "string" ? b.text : typeof b.summary === "string" ? b.summary : "";
        if (t) thoughts.push(t);
      }
    }
  }
  return { text: out.join("\n").trim(), thinking: thoughts.join("\n").trim() };
}
function basenameNoExt(filePath, ext) {
  return filePath.replace(new RegExp(`\\${ext}$`), "").split("/").pop() ?? filePath;
}

// src/parsers/claude-code.ts
function parseClaudeCodeTranscript(text, opts) {
  const id = opts.id ?? (opts.filePath ? basenameNoExt(opts.filePath, ".jsonl") : void 0);
  if (!id) throw new Error("parseClaudeCodeTranscript: opts.id or opts.filePath is required");
  const slugProject = opts.filePath ? decodeClaudeProjectSlug(opts.filePath) : null;
  const messages = [];
  let model = null;
  let sourceVersion = null;
  let title = null;
  let cwd = slugProject;
  let sidechainCount = 0;
  let metaCount = 0;
  let compactionCount = 0;
  const tokensByLane = /* @__PURE__ */ new Map();
  const seenUsageIds = /* @__PURE__ */ new Set();
  const seenContent = /* @__PURE__ */ new Set();
  const mainLane = opts.agent !== void 0 ? { agent: opts.agent, agentLabel: opts.agentLabel ?? null } : null;
  const rows = [];
  const byUuid = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    rows.push(row);
    if (typeof row.uuid === "string") byUuid.set(row.uuid, row);
  }
  const laneCache = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.isMeta === true) {
      metaCount++;
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      title = row.aiTitle;
      continue;
    }
    if (row.type === "summary" && typeof row.summary === "string") {
      if (title === null) title = row.summary;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const message = row.message;
    if (!message || typeof message !== "object") continue;
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    const role = row.type;
    if (typeof row.version === "string") sourceVersion = row.version;
    if (typeof row.cwd === "string") cwd = row.cwd;
    if (row.isCompactSummary === true) compactionCount++;
    const sidechain = row.isSidechain === true;
    if (sidechain) sidechainCount++;
    const lane = sidechain ? sidechainLane(row, byUuid, laneCache, opts) : mainLane ?? { agent: null, agentLabel: null };
    const msgId = typeof message.id === "string" ? message.id : null;
    if (role === "assistant") {
      if (typeof message.model === "string") model = message.model;
      const usage = extractTokens(message.usage);
      if (usage && (!msgId || !seenUsageIds.has(msgId))) {
        if (msgId) seenUsageIds.add(msgId);
        const key = lane.agent ?? "main";
        let acc = tokensByLane.get(key);
        if (!acc) {
          acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          tokensByLane.set(key, acc);
        }
        acc.input += usage.input;
        acc.output += usage.output;
        const u = message.usage;
        acc.cacheRead += num(u.cache_read_input_tokens);
        acc.cacheWrite += num(u.cache_creation_input_tokens);
      }
    }
    const contentKey = msgId ? `${msgId}:${JSON.stringify(message.content ?? null)}` : null;
    if (contentKey) {
      if (seenContent.has(contentKey)) continue;
      seenContent.add(contentKey);
    }
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) messages.push(makeMsg({ role, content, timestamp: ts, model, ...lane }));
      continue;
    }
    const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim()) messages.push(makeMsg({ role, content: b.text, timestamp: ts, model, ...lane }));
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        if (b.thinking.trim()) {
          messages.push(
            makeMsg({ role: "assistant", content: "", thinking: b.thinking, timestamp: ts, model, ...lane })
          );
        }
      } else if (b.type === "tool_use") {
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: typeof b.name === "string" ? b.name : "unknown",
            toolInput: b.input ?? null,
            toolCallId: typeof b.id === "string" ? b.id : null,
            timestamp: ts,
            model,
            ...lane
          })
        );
      } else if (b.type === "tool_result") {
        const inner = b.content;
        let text2 = "";
        if (typeof inner === "string") text2 = inner;
        else if (Array.isArray(inner)) {
          text2 = inner.map(
            (x) => x && typeof x === "object" && x.type === "text" ? String(x.text ?? "") : ""
          ).join("\n");
        }
        const isError = b.is_error === true;
        messages.push(
          makeMsg({
            role: "tool",
            content: text2,
            toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
            timestamp: ts,
            // Only claim a signal when the source actually provided one: a
            // missing `is_error` key means "unknown", not "success".
            ...typeof b.is_error === "boolean" ? {
              toolResult: {
                status: isError ? "error" : "success",
                method: "source_is_error",
                errorText: isError ? text2.slice(0, 500) : null,
                detail: {}
              }
            } : {},
            ...lane
          })
        );
      }
    }
  }
  if (messages.length === 0) return null;
  const grand = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tokensByAgent = {};
  for (const [lane, t] of tokensByLane) {
    if (t.input + t.output === 0) continue;
    grand.input += t.input;
    grand.output += t.output;
    grand.cacheRead += t.cacheRead;
    grand.cacheWrite += t.cacheWrite;
    tokensByAgent[lane] = { ...t };
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && (m.agent ?? "main") === lane);
    if (lastAssistant) lastAssistant.tokens = { ...t };
  }
  const hasTokens = Object.keys(tokensByAgent).length > 0;
  return buildSession({
    id,
    source: opts.source,
    sourceVersion,
    title,
    model,
    projectPath: cwd,
    messages,
    ...hasTokens ? { tokens: grand } : {},
    rawMeta: {
      slugProject,
      ...sidechainCount > 0 ? { sidechainMessages: sidechainCount } : {},
      ...metaCount > 0 ? { metaMessages: metaCount } : {},
      ...compactionCount > 0 ? { compactions: compactionCount } : {},
      ...hasTokens ? { tokensByAgent } : {}
    }
  });
}
function sidechainLane(row, byUuid, cache, opts) {
  let root = row;
  const seen = /* @__PURE__ */ new Set();
  for (; ; ) {
    const parentId = typeof root.parentUuid === "string" ? root.parentUuid : null;
    const parent = parentId ? byUuid.get(parentId) : void 0;
    if (!parentId || !parent || parent.isSidechain !== true || seen.has(parentId)) break;
    seen.add(parentId);
    root = parent;
  }
  const rootKey = typeof root.uuid === "string" ? root.uuid : "";
  const cached = cache.get(rootKey);
  if (cached) return cached;
  let lane = {
    agent: opts.agent ?? (rootKey ? `sidechain-${rootKey}` : "sidechain"),
    agentLabel: opts.agentLabel ?? null
  };
  const anchorId = typeof root.parentUuid === "string" ? root.parentUuid : null;
  const anchor = anchorId ? byUuid.get(anchorId) : void 0;
  const task = anchor ? findTaskCall(anchor) : null;
  if (task) {
    lane = { agent: task.id ?? lane.agent, agentLabel: task.label ?? lane.agentLabel };
  }
  cache.set(rootKey, lane);
  return lane;
}
function findTaskCall(anchorRow) {
  const message = anchorRow.message;
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  let fallback = null;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type !== "tool_use") continue;
    const input = b.input ?? {};
    const label = typeof input.description === "string" ? input.description : typeof input.subagent_type === "string" ? input.subagent_type : typeof b.name === "string" ? b.name : null;
    const entry = { id: typeof b.id === "string" ? b.id : null, label };
    if (b.name === "Task") return entry;
    fallback ??= entry;
  }
  return fallback;
}
function decodeClaudeProjectSlug(filePath) {
  const dir = filePath.split("/").slice(0, -1).pop();
  if (!dir?.startsWith("-")) return null;
  const slug = dir.slice(1);
  for (const prefix of ["home-", "Users-", "mnt-c-Users-"]) {
    if (slug.startsWith(prefix)) {
      return `/${slug.slice(prefix.length).replace(/-/g, "/")}`;
    }
  }
  return null;
}
function num(v) {
  return typeof v === "number" ? v : 0;
}

// src/parsers/codex-family.ts
function codexVerdict(output) {
  if (output === "") return void 0;
  const newer = /Exit code: (\d+)/.exec(output);
  if (newer) {
    const code = Number(newer[1]);
    return {
      status: code === 0 ? "success" : "error",
      method: "derived",
      errorText: code === 0 ? null : excerpt(output, newer.index),
      detail: { exitCode: code, envelope: "exit_code" }
    };
  }
  const older = /Process exited with code (\d+)/i.exec(output);
  if (older) {
    const code = Number(older[1]);
    return {
      status: code === 0 ? "success" : "error",
      method: "derived",
      errorText: code === 0 ? null : excerpt(output, older.index),
      detail: { exitCode: code, envelope: "process_exited" }
    };
  }
  const failed = /Command failed with exit code (\d+)/i.exec(output);
  if (failed) {
    const code = Number(failed[1]);
    return {
      status: "error",
      method: "derived",
      errorText: excerpt(output, failed.index),
      detail: { exitCode: code, envelope: "command_failed" }
    };
  }
  return void 0;
}
function excerpt(text, at) {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + 120);
  return `${start > 0 ? "\u2026" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "\u2026" : ""}`;
}
function parseCodexRollout(text, opts) {
  let id = opts.id ?? (opts.filePath ? basenameNoExt(opts.filePath, ".jsonl") : void 0);
  let projectPath = null;
  let sourceVersion = null;
  let model = null;
  const messages = [];
  const patchFiles = /* @__PURE__ */ new Set();
  let latestUsage;
  const pushMessage = (p, ts) => {
    const role = p.role;
    if (role !== "user" && role !== "assistant" && role !== "system") return;
    const content = flattenContent(p.content).text;
    if (!content) return;
    if (role === "user" && /^<environment_context>[\s\S]*<\/environment_context>$/.test(content.trim())) {
      return;
    }
    messages.push(makeMsg({ role, content, timestamp: ts, model }));
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    if (row.type === "session_meta") {
      const p2 = row.payload ?? {};
      if (typeof p2.id === "string") id = p2.id;
      if (typeof p2.cwd === "string") projectPath = p2.cwd;
      if (typeof p2.cli_version === "string") sourceVersion = p2.cli_version;
      continue;
    }
    if (row.type === "turn_context") {
      const p2 = row.payload ?? {};
      if (typeof p2.model === "string") model = p2.model;
      continue;
    }
    if (row.type === "event_msg") {
      const p2 = row.payload ?? {};
      if (p2.type === "token_count") {
        const info = p2.info ?? {};
        const u = extractTokens(info.total_token_usage);
        if (u) latestUsage = u;
      }
      continue;
    }
    if (row.type === "message") {
      const p2 = row.payload && typeof row.payload === "object" ? row.payload : row;
      pushMessage(p2, ts);
      continue;
    }
    if (row.type !== "response_item") continue;
    const p = row.payload ?? {};
    const pt = p.type;
    if (pt === "message") {
      pushMessage(p, ts);
    } else if (pt === "reasoning") {
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const thinking = summary.map(
        (s) => s && typeof s === "object" ? String(s.text ?? "") : ""
      ).filter((t) => t.length > 0).join("\n").trim();
      if (thinking) {
        messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model }));
      }
    } else if (pt === "function_call" || pt === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "unknown";
      const rawArgs = p.arguments ?? p.input;
      const input = typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? { raw: rawArgs } : rawArgs ?? null;
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: name,
          toolInput: input,
          toolCallId: typeof p.call_id === "string" ? p.call_id : null,
          timestamp: ts,
          model
        })
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
          ...verdict ? { toolResult: verdict } : {}
        })
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
    ...latestUsage ? { tokens: latestUsage } : {},
    rawMeta: patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {}
  });
  if (latestUsage) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = latestUsage;
  }
  return session;
}
function parseKimiWire(text, opts) {
  let sessionDir = "";
  let workspaceDir = "";
  let agentFromPath = "main";
  if (opts.filePath) {
    const parts = opts.filePath.split("/");
    sessionDir = parts.find((p) => p.startsWith("session_")) ?? "";
    workspaceDir = parts.find((p) => p.startsWith("wd_")) ?? "";
    const agentsIdx = parts.indexOf("agents");
    agentFromPath = agentsIdx >= 0 ? parts[agentsIdx + 1] ?? "main" : "main";
  }
  const agentName = opts.agent ?? agentFromPath;
  const id = opts.id ?? (opts.filePath ? `${sessionDir.replace(/^session_/, "") || opts.filePath}/${agentName}` : void 0);
  const projectHint = workspaceDir.replace(/^wd_/, "").replace(/_[0-9a-f]+$/, "");
  let model = null;
  let startedAtMs;
  const messages = [];
  const tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let durationMs;
  const lane = agentName === "main" ? {} : { agent: agentName, ...opts.agentLabel ? { agentLabel: opts.agentLabel } : {} };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof row.time === "number" ? row.time : void 0;
    if (t && startedAtMs === void 0) startedAtMs = t;
    const ts = isoFromSecsOrMs(t);
    switch (row.type) {
      case "profile.bind": {
        if (typeof row.modelAlias === "string") model = row.modelAlias;
        break;
      }
      case "context.append_message": {
        const m = row.message ?? {};
        const role = m.role;
        if (role !== "user" && role !== "assistant" && role !== "system") break;
        const { text: text2, thinking } = flattenContent(m.content);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (thinking) {
          messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model, ...lane }));
        }
        if (text2) {
          messages.push(makeMsg({ role, content: text2, timestamp: ts, model, ...lane }));
        }
        for (const tc of calls) {
          const c = tc;
          const argsRaw = c.arguments ?? c.input ?? c.args;
          const parsed = typeof argsRaw === "string" ? safeJsonParse(argsRaw) ?? { raw: argsRaw } : argsRaw ?? null;
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: c.name ?? c.toolName ?? "unknown",
              toolInput: parsed,
              toolCallId: typeof c.id === "string" ? c.id : null,
              timestamp: ts,
              model,
              ...lane
            })
          );
        }
        break;
      }
      case "context.append_loop_event": {
        const e = row.event ?? {};
        if (e.type === "content.part") {
          const part = e.part ?? {};
          if (part.type === "think" && part.think?.trim()) {
            messages.push(
              makeMsg({ role: "assistant", content: "", thinking: part.think, timestamp: ts, model, ...lane })
            );
          } else if (part.type === "text" && part.text?.trim()) {
            messages.push(
              makeMsg({ role: "assistant", content: part.text, timestamp: ts, model, ...lane })
            );
          }
        } else if (e.type === "tool.call") {
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: e.name || "unknown",
              toolInput: e.args ?? null,
              toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : null,
              timestamp: ts,
              model,
              ...lane
            })
          );
        } else if (e.type === "tool.result") {
          const resultText = extractToolResultText(e.result);
          const verdict = codexVerdict(resultText);
          messages.push(
            makeMsg({
              role: "tool",
              content: resultText,
              toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : null,
              timestamp: ts,
              ...verdict ? { toolResult: verdict } : {},
              ...lane
            })
          );
        }
        break;
      }
      case "usage.record": {
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
  const rawMeta = projectHint ? { projectHint, agent: agentName } : { agent: agentName };
  if (durationMs !== void 0) rawMeta.durationMs = durationMs;
  rawMeta.estimatedTokens = messages.reduce((sum, m) => sum + estTokens(m.content), 0);
  const hasTokens = tokenTotals.input + tokenTotals.output + tokenTotals.cacheRead + tokenTotals.cacheWrite > 0;
  const session = buildSession({
    id,
    source: opts.source,
    model,
    projectPath: null,
    startedAt: isoFromSecsOrMs(startedAtMs),
    messages,
    ...hasTokens ? { tokens: { ...tokenTotals } } : {},
    rawMeta
  });
  if (hasTokens) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = { ...tokenTotals };
  }
  return session;
}
function parseSessionJsonDocument(text, opts) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const meta = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  const id = opts.id ?? firstString(meta, ["id", "session_id"]) ?? (opts.filePath ? basenameNoExt(opts.filePath, ".json") : void 0);
  if (!id) throw new Error("parseSessionJsonDocument: opts.id, metadata.id, or opts.filePath is required");
  const projectPath = firstString(meta, ["cwd", "workdir", "working_directory", "project_path", "workspace", "path"]) ?? null;
  const model = firstString(meta, ["model", "model_id"]) ?? null;
  const title = firstString(meta, ["title"]) ?? null;
  const createdAt = typeof meta.created_at === "string" ? meta.created_at : null;
  const rawMessages = Array.isArray(doc.messages) ? doc.messages : [];
  const messages = [];
  for (const rm of rawMessages) {
    if (!rm || typeof rm !== "object") continue;
    const m = rm;
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    const ts = isoFromSecsOrMs(m.timestamp) ?? createdAt;
    if (role === "tool") {
      const { text: out } = flattenContent(m.content);
      const content = out || (m.content === void 0 || m.content === null ? "" : JSON.stringify(m.content));
      messages.push(
        makeMsg({
          role: "tool",
          content,
          toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : null,
          timestamp: ts
        })
      );
      continue;
    }
    const { text: text2, thinking } = flattenContent(m.content);
    if (thinking) {
      messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model }));
    }
    if (text2) {
      messages.push(makeMsg({ role, content: text2, timestamp: ts, model }));
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        const b = block;
        if (b.type === "tool_use") {
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: typeof b.name === "string" ? b.name : "unknown",
              toolInput: b.input ?? null,
              toolCallId: typeof b.id === "string" ? b.id : null,
              timestamp: ts,
              model
            })
          );
        } else if (b.type === "tool_result") {
          const inner = b.content;
          const out = typeof inner === "string" ? inner : Array.isArray(inner) ? inner.map(
            (x) => x && typeof x === "object" && x.type === "text" ? String(x.text ?? "") : ""
          ).join("\n") : "";
          messages.push(
            makeMsg({
              role: "tool",
              content: out,
              toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
              timestamp: ts
            })
          );
        }
      }
    }
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const c = tc;
      const fn = c.function && typeof c.function === "object" ? c.function : c;
      const argsRaw = fn.arguments ?? c.args;
      const parsed = typeof argsRaw === "string" ? safeJsonParse(argsRaw) ?? { raw: argsRaw } : argsRaw ?? null;
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: fn.name ?? c.name ?? "unknown",
          toolInput: parsed,
          toolCallId: typeof c.id === "string" ? c.id : null,
          timestamp: ts,
          model
        })
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
    messages
  });
}
var parseCodewhaleSession = parseSessionJsonDocument;
function callName(messages, callId) {
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
function extractToolResultText(result) {
  if (result && typeof result === "object") {
    const output = result.output;
    if (typeof output === "string") return output;
    if (output !== void 0) return JSON.stringify(output);
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}
function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return void 0;
}

// src/parsers/opencode.ts
var BASE_COLUMNS = `s.id, s.directory, s.title, s.version, s.summary_additions, s.summary_deletions,
       s.summary_files, s.time_created, s.time_updated, s.model, s.cost,
       s.tokens_input, s.tokens_output`;
var TOKEN_COLUMNS = ["tokens_reasoning", "tokens_cache_read", "tokens_cache_write"];
async function sessionColumns(db) {
  let present = /* @__PURE__ */ new Set();
  try {
    const rows = await db.prepare("PRAGMA table_info(session)").all();
    present = new Set(rows.map((r) => r.name));
  } catch {
    present = new Set(TOKEN_COLUMNS);
  }
  const extra = TOKEN_COLUMNS.map(
    (c) => present.has(c) ? `s.${c}` : `NULL AS ${c}`
  ).join(", ");
  return `${BASE_COLUMNS}, ${extra}, p.worktree`;
}
function prepareMessageStmts(db) {
  return {
    msgStmt: db.prepare(
      "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created"
    ),
    partStmt: db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created")
  };
}
async function opencodeSessionsFromDb(db, opts) {
  const sessions = await db.prepare(
    `SELECT ${await sessionColumns(db)} FROM session s LEFT JOIN project p ON p.id = s.project_id`
  ).all();
  const { msgStmt, partStmt } = prepareMessageStmts(db);
  const out = [];
  for (const row of sessions) {
    const session = await mapSessionRow(row, msgStmt, partStmt, opts);
    if (session) out.push(session);
  }
  return out;
}
async function opencodeSessionFromDb(db, sessionId, opts) {
  const rows = await db.prepare(
    `SELECT ${await sessionColumns(db)} FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?`
  ).all(sessionId);
  const row = rows[0];
  if (!row) return null;
  const { msgStmt, partStmt } = prepareMessageStmts(db);
  return mapSessionRow(row, msgStmt, partStmt, opts);
}
async function mapSessionRow(row, msgStmt, partStmt, opts) {
  const messages = [];
  const patchFiles = /* @__PURE__ */ new Set();
  const msgRows = await msgStmt.all(row.id);
  let model = row.model;
  for (const mr of msgRows) {
    let md;
    try {
      md = JSON.parse(mr.data);
    } catch {
      continue;
    }
    const role = md.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const modelField = md.model;
    const mModel = typeof modelField?.modelID === "string" ? modelField.modelID : model;
    if (typeof mModel === "string") model = mModel;
    const tsMs = typeof md.time === "object" && md.time !== null ? md.time.created : mr.time_created;
    const ts = isoFromMs(tsMs);
    const tokensRaw = extractTokens(md.tokens);
    let textContent = "";
    const partRows = await partStmt.all(mr.id);
    for (const pr of partRows) {
      let pd;
      try {
        pd = JSON.parse(pr.data);
      } catch {
        continue;
      }
      const pt = pd.type;
      if (pt === "text" && typeof pd.text === "string") {
        textContent += (textContent ? "\n" : "") + pd.text;
      } else if (pt === "tool" && typeof pd.tool === "string") {
        const state = pd.state ?? {};
        const callId = typeof pd.callID === "string" ? pd.callID : null;
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: pd.tool,
            toolInput: state.input ?? null,
            toolCallId: callId,
            timestamp: ts,
            model: mModel
          })
        );
        const output = state.output;
        const status = typeof state.status === "string" ? state.status : null;
        const errorText = typeof state.error === "string" ? state.error : null;
        if (typeof output === "string") {
          messages.push(
            makeMsg({
              role: "tool",
              content: output,
              toolName: pd.tool,
              toolCallId: callId,
              timestamp: ts,
              ...status !== null ? {
                toolResult: {
                  status: status === "error" ? "error" : status === "running" ? "unknown" : "success",
                  method: "source_status",
                  errorText: errorText === null ? null : errorText.slice(0, 500),
                  detail: {}
                }
              } : {}
            })
          );
        } else if (status === "error" || errorText !== null) {
          messages.push(
            makeMsg({
              role: "tool",
              content: "",
              toolName: pd.tool,
              toolCallId: callId,
              timestamp: ts,
              toolResult: {
                status: "error",
                method: "source_status",
                errorText: errorText === null ? null : errorText.slice(0, 500),
                detail: {}
              }
            })
          );
        }
      } else if (pt === "reasoning" && typeof pd.text === "string") {
        const thinking = pd.text.trim();
        if (thinking) {
          messages.push(
            makeMsg({
              role,
              content: "",
              thinking,
              timestamp: ts,
              model: mModel
            })
          );
        }
      } else if (pt === "patch" && Array.isArray(pd.files)) {
        for (const f of pd.files) {
          if (typeof f === "string") patchFiles.add(f);
        }
      }
    }
    textContent = textContent.trim();
    if (!textContent) continue;
    const msg = makeMsg({ role, content: textContent, timestamp: ts, model: mModel });
    if (tokensRaw) msg.tokens = tokensRaw;
    messages.push(msg);
  }
  if (messages.length === 0) return null;
  const hasRowTokens = !!(row.tokens_input || row.tokens_output || row.tokens_cache_read || row.tokens_cache_write);
  const rowTokens = {
    input: row.tokens_input ?? 0,
    output: (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0),
    cacheRead: row.tokens_cache_read ?? 0,
    cacheWrite: row.tokens_cache_write ?? 0
  };
  const session = buildSession({
    id: row.id,
    source: opts.source,
    sourceVersion: row.version,
    title: row.title,
    model,
    cost: typeof row.cost === "number" ? row.cost : null,
    projectPath: row.worktree ?? row.directory,
    startedAt: isoFromMs(row.time_created),
    endedAt: isoFromMs(row.time_updated),
    messages,
    ...hasRowTokens ? { tokens: rowTokens } : {},
    rawMeta: {
      title: row.title,
      cost: row.cost,
      additions: row.summary_additions,
      deletions: row.summary_deletions,
      filesChanged: row.summary_files,
      ...patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {}
    }
  });
  if (hasRowTokens && model) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant && !lastAssistant.tokens) {
      lastAssistant.tokens = rowTokens;
    }
  }
  return session;
}

// src/parsers/antigravity.ts
function parseAntigravityTranscript(text, opts) {
  const id = opts.id ?? (opts.filePath?.includes("/brain/") ? opts.filePath.split("/brain/")[1]?.split("/")[0] ?? opts.filePath : opts.filePath);
  if (!id) throw new Error("parseAntigravityTranscript: opts.id or opts.filePath is required");
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type;
    const ts = typeof row.created_at === "string" ? Number.isNaN(new Date(row.created_at).getTime()) ? row.created_at : new Date(row.created_at).toISOString() : null;
    const content = normalizeContent(row.content);
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
          const c = tc;
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: typeof c.name === "string" ? c.name : "unknown",
              toolInput: c.args ?? null,
              timestamp: ts
            })
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
            timestamp: ts
          })
        );
        break;
      case "VIEW_FILE":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "read",
            toolInput: extractTarget(row),
            timestamp: ts
          })
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
            timestamp: ts
          })
        );
        const output = extractString(row, "output");
        if (output) {
          const failed = /The command failed with exit code:\s*([1-9]\d*)/.exec(output);
          const ok = /The command completed successfully/.test(output);
          messages.push(
            makeMsg({
              role: "tool",
              content: output,
              toolName: "bash",
              timestamp: ts,
              ...failed || ok ? {
                toolResult: {
                  status: failed ? "error" : "success",
                  method: "derived",
                  errorText: failed ? output.slice(0, 500) : null,
                  detail: failed ? { exitCode: Number(failed[1]), providerText: true } : { providerText: true }
                }
              } : {}
            })
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
            timestamp: ts
          })
        );
        break;
      case "LIST_DIRECTORY":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "list",
            toolInput: extractTarget(row),
            timestamp: ts
          })
        );
        break;
      default:
        break;
    }
  }
  if (messages.length === 0) return null;
  return buildSession({
    id,
    source: opts.source,
    projectPath: null,
    messages
  });
}
function extractUserRequest(content) {
  if (!content) return "";
  const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return m?.[1] ? m[1].trim() : content.trim();
}
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => typeof c === "string" ? c : JSON.stringify(c)).join("\n");
  }
  return content ? JSON.stringify(content) : "";
}
function extractString(row, key) {
  const v = row[key];
  return typeof v === "string" ? v : "";
}
function extractTarget(row) {
  for (const key of ["file_path", "filePath", "path", "target", "query", "directory"]) {
    const v = row[key];
    if (typeof v === "string") return { path: v };
  }
  return {};
}

// src/parsers/hermes.ts
function parseHermesDump(text, opts) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const body = data.request?.body ?? {};
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const timestamp = typeof data.timestamp === "string" ? data.timestamp : null;
  const messages = [];
  for (const rm of rawMessages) {
    if (!rm || typeof rm !== "object") continue;
    const msg = rm;
    const role = msg.role ?? "";
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const content = normalizeHermesContent(msg.content);
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
            timestamp
          })
        );
      }
    }
  }
  if (messages.length === 0) return null;
  return buildSession({ id: opts.id, source: opts.source, messages });
}
async function hermesSessionsFromDb(db, opts) {
  const rows = await db.prepare(
    `SELECT id, title, display_name, started_at, cwd, model
       FROM sessions WHERE archived = 0 AND hidden = 0 ORDER BY started_at DESC`
  ).all();
  const msgStmt = prepareMessageStmt(db);
  const out = [];
  for (const row of rows) {
    const session = await mapSessionRow2(row, msgStmt, opts);
    if (session) out.push(session);
  }
  return out;
}
async function hermesSessionFromDb(db, sessionId, opts) {
  const rows = await db.prepare(
    `SELECT id, title, display_name, started_at, cwd, model
       FROM sessions WHERE archived = 0 AND hidden = 0 AND id = ?`
  ).all(sessionId);
  const row = rows[0];
  if (!row) return null;
  return mapSessionRow2(row, prepareMessageStmt(db), opts);
}
function prepareMessageStmt(db) {
  return db.prepare(
    `SELECT role, content, tool_calls, tool_call_id, timestamp, reasoning_content
     FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp`
  );
}
async function mapSessionRow2(row, msgStmt, opts) {
  const msgRows = await msgStmt.all(row.id);
  const messages = [];
  for (const mr of msgRows) {
    const role = mr.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const ts = isoFromSecsOrMs(mr.timestamp);
    if (role === "tool") {
      messages.push(
        makeMsg({
          role: "tool",
          content: normalizeHermesContent(mr.content),
          toolCallId: mr.tool_call_id || null,
          timestamp: ts
        })
      );
      continue;
    }
    const thinking = typeof mr.reasoning_content === "string" ? mr.reasoning_content : "";
    if (thinking.trim()) {
      messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts }));
    }
    const content = normalizeHermesContent(mr.content);
    if (content) messages.push(makeMsg({ role, content, timestamp: ts }));
    let calls = [];
    if (typeof mr.tool_calls === "string" && mr.tool_calls) {
      const parsed = safeJsonParse(mr.tool_calls);
      if (Array.isArray(parsed)) calls = parsed;
    }
    for (const tc of parseHermesToolCalls(calls)) {
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: tc.name,
          toolInput: tc.input,
          toolCallId: tc.id ?? null,
          timestamp: ts
        })
      );
    }
  }
  if (messages.length === 0) return null;
  return buildSession({
    id: row.id,
    source: opts.source,
    title: row.display_name || row.title,
    model: row.model,
    projectPath: row.cwd,
    startedAt: isoFromSecsOrMs(row.started_at),
    messages
  });
}
function parseHermesToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc) => ({
    ...tc.id ? { id: tc.id } : {},
    name: tc.function?.name || tc.name || "unknown",
    input: (() => {
      try {
        return JSON.parse(tc.function?.arguments || "{}");
      } catch {
        return tc.args || {};
      }
    })()
  }));
}
function normalizeHermesContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") return p.text || JSON.stringify(p);
      return "";
    }).join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

// src/detect.ts
function detectKind(sample) {
  const head = sample.slice(0, 64 * 1024);
  const session = detectSessionStyle(head);
  if (session) return session;
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "response_item" || obj.payload && typeof obj.payload === "object") return "codex-style";
    if ((obj.type === "user" || obj.type === "assistant") && obj.message) return "claude-style";
    if (typeof obj.role === "string" && obj.content !== void 0) return "chat-style";
    return null;
  }
  return null;
}
function detectSessionStyle(sample) {
  const trimmed = sample.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(sample);
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
function isSessionShapedObject(obj) {
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0];
  return !!first && typeof first === "object" && typeof first.role === "string" && first.content !== void 0;
}
function parseChatTranscript(text, opts) {
  const messages = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const role = obj.role;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
    const content = typeof obj.content === "string" ? obj.content : obj.content === void 0 ? "" : JSON.stringify(obj.content);
    if (!content) continue;
    let timestamp = null;
    if (obj.timestamp !== void 0) {
      const d = new Date(obj.timestamp);
      timestamp = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    messages.push(makeMsg({ role, content, timestamp }));
  }
  if (messages.length === 0) return null;
  return buildSession({ id: opts.id, source: opts.source, messages });
}
function parseDetectedTranscript(kind, text, opts) {
  switch (kind) {
    case "claude-style":
      return parseClaudeCodeTranscript(text, opts);
    case "codex-style":
      return parseCodexRollout(text, opts);
    case "session-style":
      return parseSessionJsonDocument(text, opts);
    case "chat-style": {
      const id = opts.id ?? (opts.filePath ? opts.filePath.replace(/\.(jsonl|json)$/i, "") : void 0);
      if (!id) throw new Error("parseDetectedTranscript(chat-style): opts.id or opts.filePath is required");
      return parseChatTranscript(text, { ...opts, id });
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildSession,
  collectPatchFiles,
  decodeClaudeProjectSlug,
  detectKind,
  estTokens,
  extractTokens,
  flattenContent,
  hermesSessionFromDb,
  hermesSessionsFromDb,
  isoFromMs,
  isoFromSecsOrMs,
  makeMsg,
  makeNirSession,
  nirMessageSchema,
  nirRoleSchema,
  nirSessionSchema,
  nirTokenUsageSchema,
  nirToolResultSchema,
  opencodeSessionFromDb,
  opencodeSessionsFromDb,
  parseAntigravityTranscript,
  parseChatTranscript,
  parseClaudeCodeTranscript,
  parseCodewhaleSession,
  parseCodexRollout,
  parseDetectedTranscript,
  parseHermesDump,
  parseKimiWire,
  parseSessionJsonDocument,
  safeJsonParse
});
