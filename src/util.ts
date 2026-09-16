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

export function makeMsg(partial: Partial<NirMessage> & { role: NirMessage["role"] }): NirMessage {
  // Spread partial FIRST so explicitly-passed defaults win; then re-apply the
  // fallbacks only for keys that are still undefined.
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

export function extractTokens(obj: unknown): { input: number; output: number } | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  if (o.input_tokens !== undefined || o.output_tokens !== undefined) {
    return {
      input: pick("input_tokens", "prompt_tokens"),
      output: pick("output_tokens", "completion_tokens"),
    };
  }
  if (o.prompt_tokens !== undefined || o.completion_tokens !== undefined) {
    return {
      input: pick("prompt_tokens", "input_tokens"),
      output: pick("completion_tokens", "output_tokens"),
    };
  }
  if (o.input !== undefined || o.output !== undefined) {
    return { input: pick("input"), output: pick("output") };
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
