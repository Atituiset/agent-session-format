import type { NirMessage, NirSession } from "./schema.js";

export function isoFromMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

// Kimi/codewhale timestamps are sometimes seconds, sometimes milliseconds.
export function isoFromSecsOrMs(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? new Date(v < 1e12 ? v * 1000 : v).toISOString()
    : null;
}

export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Extract `*** Update/Add/Delete File:` names from an apply_patch body.
export function collectPatchFiles(patch: string, out: Set<string>): void {
  const re = /\*\*\* (Update|Add|Delete) File: (.+)/g;
  for (const m of patch.matchAll(re)) {
    const name = m[2];
    if (name) out.add(name.trim());
  }
}

/**
 * File-path-ish keys in tool inputs, across every harness measured so far.
 *
 * Owned here because it is a wire-format fact, not an interpretation: these are
 * simply the spellings the harnesses use. It was previously duplicated in four
 * places (session-forge `enrich/index.ts`, session-forge `writers/codex_rollup.ts`,
 * behavior-lab `canonical.ts`, and ad-hoc in the viewer), each with a different
 * list and order, none of which could see the others drift.
 *
 * Order matters and is not alphabetical: the more specific spellings come first
 * so a tool that carries both `file_path` and a generic `path` resolves to the
 * real target. `query` is deliberately NOT here — it is a search term, not a path,
 * and including it is what let opencode's `extractTarget` return a grep pattern as
 * if it were a file.
 */
export const FILE_PATH_KEYS = [
  "filePath",
  "file_path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
  "path",
  "file",
] as const;

/** Pull the target file path out of a tool input, or null if it has none. */
export function targetPathOf(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const obj = toolInput as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

export function makeMsg(partial: Partial<NirMessage> & { role: NirMessage["role"] }): NirMessage {
  // Spread partial FIRST so explicitly-passed defaults win; then re-apply the
  // fallbacks only for keys that are still undefined.
  return {
    ...partial,
    content: partial.content ?? "",
    timestamp: partial.timestamp ?? null,
    toolName: partial.toolName ?? null,
    toolInput: partial.toolInput ?? null,
    // Derived, never passed in by a parser: the target path is a fact about the
    // wire format's spelling, and deriving it here means no parser can forget.
    //
    // It hangs on the CALL message rather than on toolResult because reading a
    // file does not require knowing whether the read succeeded — 79% of calls
    // carry no verdict, and attaching targets there would hide them from exactly
    // the majority of calls that touch a file.
    toolTarget: partial.toolTarget ?? targetPathOf(partial.toolInput),
    toolCallId: partial.toolCallId ?? null,
    model: partial.model ?? null,
    thinking: partial.thinking ?? null,
    agent: partial.agent ?? null,
    agentLabel: partial.agentLabel ?? null,
  };
}

export function buildSession(partial: {
  id: string;
  source: string;
  sourceVersion?: string | null;
  title?: string | null;
  model?: string | null;
  cost?: number | null;
  projectPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  tokens?: NirSession["tokens"];
  messages: NirMessage[];
  rawMeta?: Record<string, unknown>;
}): NirSession {
  const times = partial.messages
    .map((m) => m.timestamp)
    .filter((t): t is string => typeof t === "string");
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
    ...(partial.tokens ? { tokens: partial.tokens } : {}),
    messages: partial.messages,
    rawMeta: partial.rawMeta ?? {},
  };
}

/**
 * Normalize provider usage objects to NIR token usage.
 *
 * Semantics: `input` is FRESH (non-cached) input tokens; cached portions live
 * in cacheRead/cacheWrite and are never double-counted into input. Providers
 * differ: Codex/Responses `input_tokens` INCLUDES the cached part (subtract
 * it), while Anthropic (`cache_read_input_tokens`) and Kimi (`inputOther` +
 * `inputCacheRead`) report fresh input separately from cache.
 */
export interface ExtractedTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function extractTokens(obj: unknown): ExtractedTokens | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  const cacheObj =
    typeof o.cache === "object" && o.cache !== null
      ? (o.cache as Record<string, unknown>)
      : undefined;
  const cacheRead =
    pick("cached_input_tokens", "cache_read_input_tokens", "inputCacheRead", "cacheRead") +
    (typeof cacheObj?.read === "number" ? cacheObj.read : 0);
  const cacheWrite =
    pick("cache_write_input_tokens", "cache_creation_input_tokens", "inputCacheCreation", "cacheWrite") +
    (typeof cacheObj?.write === "number" ? cacheObj.write : 0);
  if (o.input_tokens !== undefined || o.output_tokens !== undefined || o.prompt_tokens !== undefined || o.completion_tokens !== undefined) {
    const rawIn = pick("input_tokens", "prompt_tokens");
    const inclusive = o.cached_input_tokens !== undefined || o.cache_write_input_tokens !== undefined;
    return {
      input: inclusive ? Math.max(0, rawIn - cacheRead - cacheWrite) : rawIn,
      output: pick("output_tokens", "completion_tokens"),
      cacheRead,
      cacheWrite,
    };
  }
  if (o.input !== undefined || o.output !== undefined || o.inputOther !== undefined) {
    return {
      input: pick("input", "inputs", "inputOther"),
      // opencode reports reasoning separately; providers bill it as output.
      output: pick("output", "outputs") + pick("reasoning"),
      cacheRead,
      cacheWrite,
    };
  }
  if (cacheRead + cacheWrite > 0) {
    return { input: 0, output: 0, cacheRead, cacheWrite };
  }
  return undefined;
}

// Shared content-block flattener: plain string, Claude-style blocks
// (text/thinking), Responses-style blocks (input_text/output_text), and
// reasoning blocks → { text, thinking }.
export function flattenContent(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  // A single block object (not wrapped in an array) still parses.
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return flattenContent([content]);
  }
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const out: string[] = [];
  const thoughts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "input_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "output_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "summary_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
      else if (b.type === "think" && typeof b.think === "string") thoughts.push(b.think);
      else if (b.type === "reasoning") {
        const t =
          typeof b.text === "string" ? b.text : typeof b.summary === "string" ? b.summary : "";
        if (t) thoughts.push(t);
      }
    }
  }
  return { text: out.join("\n").trim(), thinking: thoughts.join("\n").trim() };
}

export function basenameNoExt(filePath: string, ext: string): string {
  return filePath.replace(new RegExp(`\\${ext}$`), "").split("/").pop() ?? filePath;
}
