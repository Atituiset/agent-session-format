import { z } from "zod";

export const nirRoleSchema = z.enum(["user", "assistant", "tool", "system"]);

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
  // Tool-call correlation id (Claude `tool_use.id`, Codex `call_id`, OpenAI
  // `tool_calls[].id`). Set on both the assistant tool-call message and the
  // tool-result message so consumers can pair them.
  toolCallId: z.string().nullable().default(null),
  model: z.string().nullable(),
  thinking: z.string().nullable().default(null),
  tokens: nirTokenUsageSchema.optional(),
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
