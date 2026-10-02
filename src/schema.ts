import { z } from "zod";

export const nirRoleSchema = z.enum(["user", "assistant", "tool", "system"]);

/**
 * Structured outcome of a tool call, when the SOURCE FORMAT PROVIDES ONE.
 *
 * Why this exists: until 0.5.0, NIR carried no success/failure signal at all —
 * tool results were flattened into `content` and consumers had to regex them.
 * Measured on a real corpus, that made a verdict recoverable for ~0.2% of
 * opencode tool results and ~11% of Claude's, so any outcome-conditioned
 * analysis was mostly measuring which harness happens to write exit codes into
 * its transcripts.
 *
 * Most source formats DO carry a structured signal and the parsers were
 * discarding it. Measured availability in the raw formats:
 *
 *   claude-code   tool_result.is_error            — boolean, present on most rows
 *   opencode      part.state.status ("completed" | "error" | "running") + state.error
 *   antigravity   output shape ("completed successfully" / failure text)
 *   codex         payload has only {call_id, output} — NO structured signal
 *   hermes        message row has no verdict column — NO structured signal
 *
 * `method` records WHICH of these produced the status, so a consumer can tell a
 * source-reported failure from a derived one, and can report coverage honestly.
 * Absent field = the source provided nothing. That is different from
 * `status: "unknown"`, which means the source provided a signal we could not
 * interpret.
 */
export const nirToolResultSchema = z.object({
  status: z.enum(["success", "error", "cancelled", "unknown"]),
  /**
   * `source_is_error`   — claude `tool_result.is_error`
   * `source_status`     — opencode/antigravity part state status
   * `source_error_text` — opencode `state.error` carried over verbatim
   * `derived`           — inferred from output text (last resort, see `detail`)
   */
  method: z.enum(["source_is_error", "source_status", "derived"]),
  /** Verbatim provider error text, when the source exposed one. */
  errorText: z.string().nullable().default(null),
  /** Provider-specific extras (exit code, background-task flag), when present. */
  detail: z.record(z.string(), z.unknown()).default({}),
});

export type NirToolResult = z.infer<typeof nirToolResultSchema>;

export const nirTokenUsageSchema = z.object({
  input: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
});

export const nirMessageSchema = z.object({
  role: nirRoleSchema,
  content: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().nullable(),
  toolInput: z.unknown(),
  /**
   * Normalized file path this call targets, or null when it targets none.
   *
   * Derived by `makeMsg` from the harness's own field spelling (see
   * `targetPathOf`) so no parser has to remember it. Optional and nullable on
   * purpose: a 0.7 consumer is unaffected, and a call that touches no file says
   * so honestly rather than by omission.
   *
   * It lives on the CALL rather than on `toolResult` because reading a file does
   * not depend on the read having succeeded — 79% of calls carry no verdict, and
   * nesting targets there would hide them from the majority of file-touching
   * calls.
   */
  toolTarget: z.string().nullable().default(null),
  // Tool-call correlation id (Claude `tool_use.id`, Codex `call_id`, OpenAI
  // `tool_calls[].id`). Set on both the assistant tool-call message and the
  // tool-result message so consumers can pair them.
  toolCallId: z.string().nullable().default(null),
  model: z.string().nullable(),
  thinking: z.string().nullable().default(null),
  tokens: nirTokenUsageSchema.optional(),
  // Structured tool outcome, set ONLY on `role: "tool"` messages and ONLY when
  // the source format provided a signal. Absent means "the source said nothing",
  // which is NOT the same as `status: "unknown"`.
  toolResult: nirToolResultSchema.optional(),
  // Swimlane id for subagent messages; absent/null means the main lane.
  agent: z.string().nullable().default(null),
  agentLabel: z.string().nullable().default(null),
});

export const nirSessionSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceVersion: z.string().nullable(),
  title: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  cost: z.number().nullable().default(null),
  projectPath: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  // Session-level token totals when the source reports them (opencode rows,
  // accumulated Claude/Kimi usage). Per-message `tokens` may still differ.
  tokens: nirTokenUsageSchema.optional(),
  messages: z.array(nirMessageSchema).min(1),
  rawMeta: z.record(z.string(), z.unknown()).default({}),
});

export type NirRole = z.infer<typeof nirRoleSchema>;
export type NirTokenUsage = z.infer<typeof nirTokenUsageSchema>;
export type NirMessage = z.infer<typeof nirMessageSchema>;
export type NirSession = z.infer<typeof nirSessionSchema>;

export function makeNirSession(input: unknown): NirSession {
  return nirSessionSchema.parse(input);
}
