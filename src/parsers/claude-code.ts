import type { NirMessage, NirSession, NirTokenUsage } from "../schema.js";
import { basenameNoExt, buildSession, extractTokens, makeMsg } from "../util.js";

export interface ParseOptions {
  /** Tool id recorded as `session.source` (e.g. "claude-code"). */
  source: string;
  /** Session id. Falls back to the file name (minus extension) when filePath is given. */
  id?: string;
  /** Origin file path; only used to derive the id and (for Claude Code) the project slug. */
  filePath?: string;
  /** Swimlane tags applied to every parsed message — pass these when parsing a
   * subagent transcript file so its messages land in their own lane. */
  agent?: string;
  agentLabel?: string;
}

/**
 * Parse one Claude Code `.jsonl` transcript into a NIR session.
 * Pure: content in, NIR out. Returns null when no messages parse.
 *
 * Sidechain (subagent) rows are parsed into their own swimlane instead of
 * dropped: the lane id is the spawning `Task` tool_use id when it can be
 * resolved from the parent chain, and `agentLabel` carries the Task
 * description. Rows flagged `isMeta` (command caveats etc.) are skipped;
 * compaction summary rows parse as user messages. Both are counted in
 * `rawMeta`. Token usage is deduplicated by `message.id` — Claude repeats
 * rows (with the full usage object) when a streamed message is retried —
 * and accumulated per swimlane: `rawMeta.tokensByAgent` holds the per-lane
 * breakdown, `session.tokens` the grand total.
 */
export function parseClaudeCodeTranscript(text: string, opts: ParseOptions): NirSession | null {
  const id = opts.id ?? (opts.filePath ? basenameNoExt(opts.filePath, ".jsonl") : undefined);
  if (!id) throw new Error("parseClaudeCodeTranscript: opts.id or opts.filePath is required");
  const slugProject = opts.filePath ? decodeClaudeProjectSlug(opts.filePath) : null;
  const messages: NirMessage[] = [];
  let model: string | null = null;
  let sourceVersion: string | null = null;
  let title: string | null = null;
  let cwd: string | null = slugProject;
  let sidechainCount = 0;
  let metaCount = 0;
  let compactionCount = 0;
  // Token usage is accumulated per swimlane ("main" for the primary lane);
  // the breakdown lands in rawMeta.tokensByAgent and the grand total in
  // session.tokens.
  const tokensByLane = new Map<string, NirTokenUsage>();
  const seenUsageIds = new Set<string>();
  const seenContent = new Set<string>();
  const mainLane =
    opts.agent !== undefined ? { agent: opts.agent, agentLabel: opts.agentLabel ?? null } : null;

  // Pass 1: parse rows and index by uuid so sidechain rows can resolve the
  // main-lane Task call that spawned them via the parentUuid chain.
  const rows: Record<string, unknown>[] = [];
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    rows.push(row);
    if (typeof row.uuid === "string") byUuid.set(row.uuid, row);
  }
  const laneCache = new Map<string, { agent: string; agentLabel: string | null }>();

  for (const row of rows) {
    if (row.isMeta === true) {
      // Local-command caveats and similar harness noise, not conversation.
      metaCount++;
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      title = row.aiTitle;
      continue;
    }
    if (row.type === "summary" && typeof row.summary === "string") {
      // Claude's one-line session summary; ai-title wins when both exist.
      if (title === null) title = row.summary;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const message = row.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    const role = row.type as "user" | "assistant";
    if (typeof row.version === "string") sourceVersion = row.version;
    if (typeof row.cwd === "string") cwd = row.cwd;
    if (row.isCompactSummary === true) compactionCount++;

    const sidechain = row.isSidechain === true;
    if (sidechain) sidechainCount++;
    const lane = sidechain
      ? sidechainLane(row, byUuid, laneCache, opts)
      : (mainLane ?? { agent: null, agentLabel: null });

    const msgId = typeof message.id === "string" ? message.id : null;
    if (role === "assistant") {
      if (typeof message.model === "string") model = message.model;
      const usage = extractTokens(message.usage);
      // Streaming retries repeat the row with the same message.id and the
      // full usage object — count usage once per message.id.
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
        const u = message.usage as Record<string, unknown>;
        acc.cacheRead += num(u.cache_read_input_tokens);
        acc.cacheWrite += num(u.cache_creation_input_tokens);
      }
    }

    // Skip exact-duplicate rows (same message.id, same content payload).
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
    // Content blocks are usually an array; a single bare block still parses.
    const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim()) messages.push(makeMsg({ role, content: b.text, timestamp: ts, model, ...lane }));
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        // `redacted_thinking` blocks carry no usable text and are ignored.
        if (b.thinking.trim()) {
          messages.push(
            makeMsg({ role: "assistant", content: "", thinking: b.thinking, timestamp: ts, model, ...lane }),
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
            ...lane,
          }),
        );
      } else if (b.type === "tool_result") {
        const inner = b.content;
        let text = "";
        if (typeof inner === "string") text = inner;
        else if (Array.isArray(inner)) {
          text = inner
            .map((x) =>
              x && typeof x === "object" && (x as Record<string, unknown>).type === "text"
                ? String((x as Record<string, unknown>).text ?? "")
                : "",
            )
            .join("\n");
        }
        // Claude Code records the tool's verdict structurally in
        // `tool_result.is_error`. Until 0.5.0 this was dropped, forcing every
        // consumer to regex the output text — which recovered a verdict for only
        // ~11% of results, because most successful tools print nothing
        // recognizable. `is_error` is present on most rows and is authoritative.
        const isError = b.is_error === true;
        messages.push(
          makeMsg({
            role: "tool",
            content: text,
            toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
            timestamp: ts,
            // Only claim a signal when the source actually provided one: a
            // missing `is_error` key means "unknown", not "success".
            ...(typeof b.is_error === "boolean"
              ? {
                  toolResult: {
                    status: isError ? ("error" as const) : ("success" as const),
                    method: "source_is_error" as const,
                    errorText: isError ? text.slice(0, 500) : null,
                    detail: {},
                  },
                }
              : {}),
            ...lane,
          }),
        );
      }
    }
  }

  if (messages.length === 0) return null;
  const grand: NirTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tokensByAgent: Record<string, NirTokenUsage> = {};
  for (const [lane, t] of tokensByLane) {
    if (t.input + t.output === 0) continue;
    grand.input += t.input;
    grand.output += t.output;
    grand.cacheRead += t.cacheRead;
    grand.cacheWrite += t.cacheWrite;
    tokensByAgent[lane] = { ...t };
    // Each lane's totals ride on that lane's last assistant message.
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && (m.agent ?? "main") === lane);
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
    ...(hasTokens ? { tokens: grand } : {}),
    rawMeta: {
      slugProject,
      ...(sidechainCount > 0 ? { sidechainMessages: sidechainCount } : {}),
      ...(metaCount > 0 ? { metaMessages: metaCount } : {}),
      ...(compactionCount > 0 ? { compactions: compactionCount } : {}),
      ...(hasTokens ? { tokensByAgent } : {}),
    },
  });
}

/**
 * Resolve the swimlane for a sidechain row: walk the parentUuid chain to the
 * sidechain root, then to the main-lane assistant row that launched it. When
 * that row holds a `Task` tool_use, the lane id is the tool_use id (so it
 * correlates with the main-lane tool call) and the label its description.
 */
function sidechainLane(
  row: Record<string, unknown>,
  byUuid: Map<string, Record<string, unknown>>,
  cache: Map<string, { agent: string; agentLabel: string | null }>,
  opts: ParseOptions,
): { agent: string; agentLabel: string | null } {
  let root = row;
  const seen = new Set<string>();
  for (;;) {
    const parentId = typeof root.parentUuid === "string" ? root.parentUuid : null;
    const parent = parentId ? byUuid.get(parentId) : undefined;
    if (!parentId || !parent || parent.isSidechain !== true || seen.has(parentId)) break;
    seen.add(parentId);
    root = parent;
  }
  const rootKey = typeof root.uuid === "string" ? root.uuid : "";
  const cached = cache.get(rootKey);
  if (cached) return cached;

  let lane: { agent: string; agentLabel: string | null } = {
    agent: opts.agent ?? (rootKey ? `sidechain-${rootKey}` : "sidechain"),
    agentLabel: opts.agentLabel ?? null,
  };
  const anchorId = typeof root.parentUuid === "string" ? root.parentUuid : null;
  const anchor = anchorId ? byUuid.get(anchorId) : undefined;
  const task = anchor ? findTaskCall(anchor) : null;
  if (task) {
    lane = { agent: task.id ?? lane.agent, agentLabel: task.label ?? lane.agentLabel };
  }
  cache.set(rootKey, lane);
  return lane;
}

function findTaskCall(anchorRow: Record<string, unknown>): { id: string | null; label: string | null } | null {
  const message = anchorRow.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  let fallback: { id: string | null; label: string | null } | null = null;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    const label =
      typeof input.description === "string"
        ? input.description
        : typeof input.subagent_type === "string"
          ? input.subagent_type
          : typeof b.name === "string"
            ? b.name
            : null;
    const entry = { id: typeof b.id === "string" ? b.id : null, label };
    if (b.name === "Task") return entry;
    fallback ??= entry;
  }
  return fallback;
}

// Claude Code encodes the project dir as a flat slug (`-home-me-my-project`).
// Dashes are ambiguous (path separators vs. hyphens in names like `my-app`),
// so only split on dashes that follow known root prefixes; otherwise leave the
// project path null rather than guess a mangled path.
export function decodeClaudeProjectSlug(filePath: string): string | null {
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

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
