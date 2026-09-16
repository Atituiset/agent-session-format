import { z } from 'zod';

declare const nirRoleSchema: z.ZodEnum<{
    user: "user";
    assistant: "assistant";
    tool: "tool";
    system: "system";
}>;
declare const nirTokenUsageSchema: z.ZodObject<{
    input: z.ZodDefault<z.ZodNumber>;
    output: z.ZodDefault<z.ZodNumber>;
    cacheRead: z.ZodDefault<z.ZodNumber>;
    cacheWrite: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
declare const nirMessageSchema: z.ZodObject<{
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        tool: "tool";
        system: "system";
    }>;
    content: z.ZodString;
    timestamp: z.ZodNullable<z.ZodString>;
    toolName: z.ZodNullable<z.ZodString>;
    toolInput: z.ZodUnknown;
    toolCallId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    model: z.ZodNullable<z.ZodString>;
    thinking: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tokens: z.ZodOptional<z.ZodObject<{
        input: z.ZodDefault<z.ZodNumber>;
        output: z.ZodDefault<z.ZodNumber>;
        cacheRead: z.ZodDefault<z.ZodNumber>;
        cacheWrite: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    agent: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    agentLabel: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
declare const nirSessionSchema: z.ZodObject<{
    id: z.ZodString;
    source: z.ZodString;
    sourceVersion: z.ZodNullable<z.ZodString>;
    title: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    cost: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    projectPath: z.ZodNullable<z.ZodString>;
    startedAt: z.ZodNullable<z.ZodString>;
    endedAt: z.ZodNullable<z.ZodString>;
    tokens: z.ZodOptional<z.ZodObject<{
        input: z.ZodDefault<z.ZodNumber>;
        output: z.ZodDefault<z.ZodNumber>;
        cacheRead: z.ZodDefault<z.ZodNumber>;
        cacheWrite: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            user: "user";
            assistant: "assistant";
            tool: "tool";
            system: "system";
        }>;
        content: z.ZodString;
        timestamp: z.ZodNullable<z.ZodString>;
        toolName: z.ZodNullable<z.ZodString>;
        toolInput: z.ZodUnknown;
        toolCallId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        model: z.ZodNullable<z.ZodString>;
        thinking: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        tokens: z.ZodOptional<z.ZodObject<{
            input: z.ZodDefault<z.ZodNumber>;
            output: z.ZodDefault<z.ZodNumber>;
            cacheRead: z.ZodDefault<z.ZodNumber>;
            cacheWrite: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        agent: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        agentLabel: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    rawMeta: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
type NirRole = z.infer<typeof nirRoleSchema>;
type NirTokenUsage = z.infer<typeof nirTokenUsageSchema>;
type NirMessage = z.infer<typeof nirMessageSchema>;
type NirSession = z.infer<typeof nirSessionSchema>;
declare function makeNirSession(input: unknown): NirSession;

declare function isoFromMs(ms: number | null | undefined): string | null;
declare function isoFromSecsOrMs(v: unknown): string | null;
declare function estTokens(text: string): number;
declare function safeJsonParse(text: string): unknown;
declare function collectPatchFiles(patch: string, out: Set<string>): void;
declare function makeMsg(partial: Partial<NirMessage> & {
    role: NirMessage["role"];
}): NirMessage;
declare function buildSession(partial: {
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
}): NirSession;
declare function extractTokens(obj: unknown): {
    input: number;
    output: number;
} | undefined;
declare function flattenContent(content: unknown): {
    text: string;
    thinking: string;
};

/**
 * Minimal sqlite interface injected by the consumer. The package never opens a
 * database itself — all file I/O, snapshotting, and driver choice stay in the
 * consuming app.
 *
 * Both shapes used by the consumers satisfy this interface:
 * - synchronous drivers (bun:sqlite `Database`, better-sqlite3 `Database`):
 *   `db.prepare(sql).all(...params)` returns rows directly;
 * - async drivers (agent-viewer's remote WSL/SSH query bridge): `all` returns
 *   a Promise of rows.
 *
 * The package `await`s every result, so sync and async implementations both
 * work unchanged.
 */
interface SqliteStatement {
    all(...params: unknown[]): unknown[] | Promise<unknown[]>;
}
interface SqliteDb {
    prepare(sql: string): SqliteStatement;
}

interface ParseOptions {
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
declare function parseClaudeCodeTranscript(text: string, opts: ParseOptions): NirSession | null;
declare function decodeClaudeProjectSlug(filePath: string): string | null;

interface KimiWireOptions extends ParseOptions {
    /** Agent lane name; overrides the `agents/<name>` path segment when set. */
    agent?: string;
}
/**
 * Parse a Codex CLI rollout `.jsonl` (also used by DeepSeek and other
 * Responses-API-style event streams). Handles both the real
 * `{type:"response_item", payload}` envelope and the older flat
 * `{type:"message", payload:{role, content}}` shape.
 */
declare function parseCodexRollout(text: string, opts: ParseOptions): NirSession | null;
/**
 * Parse one Kimi Code `wire.jsonl` event stream. Handles both event styles:
 * - `context.append_message` rows carrying full message objects (with
 *   `toolCalls`), `profile.bind`, `usage.record`, `turn.ended`;
 * - `context.append_loop_event` rows (`content.part` / `tool.call` /
 *   `tool.result`) from newer runtimes.
 */
declare function parseKimiWire(text: string, opts: KimiWireOptions): NirSession | null;
/**
 * Parse a single-file JSON session document
 * `{ metadata?, messages: [{ role, content, tool_calls? }] }` — the shape used
 * by codewhale, DeepSeek, and similar OpenAI-style dumps.
 */
declare function parseSessionJsonDocument(text: string, opts: ParseOptions): NirSession | null;
/** Backwards-compatible alias: codewhale files are session-JSON documents. */
declare const parseCodewhaleSession: typeof parseSessionJsonDocument;

interface OpencodeOptions {
    /** Tool id recorded as `session.source` (e.g. "opencode"). */
    source: string;
}
/**
 * Map an opencode `opencode.db` to NIR sessions. The database is injected via
 * the minimal `SqliteDb` interface — the consumer owns opening the file (Bun's
 * `bun:sqlite`, better-sqlite3, or a remote query bridge all satisfy it).
 *
 * Streams per-session instead of preloading every message+part: real databases
 * reach multiple GB.
 */
declare function opencodeSessionsFromDb(db: SqliteDb, opts: OpencodeOptions): Promise<NirSession[]>;

/**
 * Parse one Antigravity (Gemini CLI) `transcript.jsonl`. Pure: content in,
 * NIR out. Returns null when no messages parse.
 *
 * The id defaults to the brain directory segment (`.../brain/<id>/...`) when
 * `filePath` contains one, else the file name.
 */
declare function parseAntigravityTranscript(text: string, opts: ParseOptions): NirSession | null;

/**
 * Parse a legacy Hermes request dump (`request_dump_<sessionId>_*.json`): the
 * whole file is one API request whose `request.body.messages` is the
 * OpenAI-style conversation. All messages share the dump's timestamp.
 */
declare function parseHermesDump(text: string, opts: {
    source: string;
    id: string;
}): NirSession | null;
/**
 * Map a newer Hermes `state.db` (sessions + messages tables) to NIR sessions,
 * via the injected `SqliteDb` interface.
 */
declare function hermesSessionsFromDb(db: SqliteDb, opts: {
    source: string;
}): Promise<NirSession[]>;

/**
 * Content classification for arbitrary transcript text — the heuristics behind
 * agent-viewer's self-discovery of unknown agents. CLI agent session storage
 * converges on a few shapes:
 * - claude-style:   JSONL of {type:"user"|"assistant", message:{...}, timestamp}
 * - codex-style:    JSONL of {type:"response_item", payload:{...}} rollout events
 * - chat-style:     JSONL of bare {role, content} rows (plainest dump)
 * - session-style:  one JSON document {metadata?, messages:[{role, content}]}
 */
type GenericKind = "claude-style" | "codex-style" | "chat-style" | "session-style";
/**
 * Classify a text sample (a whole file or a truncated head — e.g. the first
 * few KB). Returns null when nothing matches.
 *
 * Note the sample may be truncated mid-JSON: JSONL shapes are detected line by
 * line; session-style single-file JSON necessarily fails JSON.parse when cut,
 * so it is recognized by its key-sequence fingerprint instead.
 */
declare function detectKind(sample: string): GenericKind | null;
/**
 * Parse a chat-style transcript: one bare {role, content[, timestamp]} JSON
 * object per line, line-fault-tolerant.
 */
declare function parseChatTranscript(text: string, opts: ParseOptions & {
    id: string;
}): NirSession | null;
/**
 * Dispatch to the matching family parser for a detected kind. All four kinds
 * map onto the same family parsers used for known tools.
 */
declare function parseDetectedTranscript(kind: GenericKind, text: string, opts: ParseOptions & {
    id?: string;
}): NirSession | null;

export { type GenericKind, type KimiWireOptions, type NirMessage, type NirRole, type NirSession, type NirTokenUsage, type OpencodeOptions, type ParseOptions, type SqliteDb, type SqliteStatement, buildSession, collectPatchFiles, decodeClaudeProjectSlug, detectKind, estTokens, extractTokens, flattenContent, hermesSessionsFromDb, isoFromMs, isoFromSecsOrMs, makeMsg, makeNirSession, nirMessageSchema, nirRoleSchema, nirSessionSchema, nirTokenUsageSchema, opencodeSessionsFromDb, parseAntigravityTranscript, parseChatTranscript, parseClaudeCodeTranscript, parseCodewhaleSession, parseCodexRollout, parseDetectedTranscript, parseHermesDump, parseKimiWire, parseSessionJsonDocument, safeJsonParse };
