import type { NirMessage, NirSession } from "../schema.js";
import { basenameNoExt, buildSession, extractTokens, makeMsg } from "../util.js";

const MAX_TOOL_CONTENT = 20_000;

export interface ParseOptions {
  /** Tool id recorded as `session.source` (e.g. "claude-code"). */
  source: string;
  /** Session id. Falls back to the file name (minus extension) when filePath is given. */
  id?: string;
  /** Origin file path; only used to derive the id and (for Claude Code) the project slug. */
  filePath?: string;
}

/**
 * Parse one Claude Code `.jsonl` transcript into a NIR session.
 * Pure: content in, NIR out. Returns null when no messages parse.
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
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain === true) {
      // Subagent transcripts live in their own files; sidechain rows inlined in
      // the main file are counted and skipped.
      sidechainCount++;
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") {
      title = row.aiTitle;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const message = row.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    const role = row.type as "user" | "assistant";
    if (typeof row.version === "string") sourceVersion = row.version;
    if (typeof row.cwd === "string") cwd = row.cwd;

    if (role === "assistant") {
      if (typeof message.model === "string") model = message.model;
      const usage = extractTokens(message.usage);
      if (usage) {
        tokens.input += usage.input;
        tokens.output += usage.output;
        const u = message.usage as Record<string, unknown>;
        tokens.cacheRead += num(u.cache_read_input_tokens);
        tokens.cacheWrite += num(u.cache_creation_input_tokens);
      }
    }

    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) messages.push(makeMsg({ role, content, timestamp: ts, model }));
      continue;
    }
    // Content blocks are usually an array; a single bare block still parses.
    const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim()) messages.push(makeMsg({ role, content: b.text, timestamp: ts, model }));
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        // `redacted_thinking` blocks carry no usable text and are ignored.
        if (b.thinking.trim()) {
          messages.push(
            makeMsg({ role: "assistant", content: "", thinking: b.thinking, timestamp: ts, model }),
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
        messages.push(
          makeMsg({
            role: "tool",
            content: text.slice(0, MAX_TOOL_CONTENT),
            toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
            timestamp: ts,
          }),
        );
      }
    }
  }

  if (messages.length === 0) return null;
  const hasTokens = tokens.input + tokens.output > 0;
  if (hasTokens) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = { ...tokens };
  }
  return buildSession({
    id,
    source: opts.source,
    sourceVersion,
    title,
    model,
    projectPath: cwd,
    messages,
    ...(hasTokens ? { tokens: { ...tokens } } : {}),
    rawMeta: {
      slugProject,
      ...(sidechainCount > 0 ? { sidechainMessages: sidechainCount } : {}),
    },
  });
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
