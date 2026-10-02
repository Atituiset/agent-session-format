import type { NirMessage, NirSession } from "../schema.js";
import type { SqliteDb, SqliteStatement } from "../sqlite.js";
import { buildSession, extractTokens, isoFromMs, makeMsg } from "../util.js";

export interface OpencodeOptions {
  /** Tool id recorded as `session.source` (e.g. "opencode"). */
  source: string;
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  time_created: number | null;
  time_updated: number | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  worktree: string | null;
}

const BASE_COLUMNS = `s.id, s.directory, s.title, s.version, s.summary_additions, s.summary_deletions,
       s.summary_files, s.time_created, s.time_updated, s.model, s.cost,
       s.tokens_input, s.tokens_output`;
// Older opencode databases lack the reasoning/cache columns — detect and
// substitute NULLs so one parser version works against every schema era.
const TOKEN_COLUMNS = ["tokens_reasoning", "tokens_cache_read", "tokens_cache_write"] as const;

async function sessionColumns(db: SqliteDb): Promise<string> {
  let present = new Set<string>();
  try {
    const rows = (await db.prepare("PRAGMA table_info(session)").all()) as { name: string }[];
    present = new Set(rows.map((r) => r.name));
  } catch {
    present = new Set(TOKEN_COLUMNS); // probe failed — assume modern schema
  }
  const extra = TOKEN_COLUMNS.map((c) =>
    present.has(c) ? `s.${c}` : `NULL AS ${c}`,
  ).join(", ");
  return `${BASE_COLUMNS}, ${extra}, p.worktree`;
}

function prepareMessageStmts(db: SqliteDb): { msgStmt: SqliteStatement; partStmt: SqliteStatement } {
  return {
    msgStmt: db.prepare(
      "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created",
    ),
    partStmt: db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created"),
  };
}

/**
 * Map an opencode `opencode.db` to NIR sessions. The database is injected via
 * the minimal `SqliteDb` interface — the consumer owns opening the file (Bun's
 * `bun:sqlite`, better-sqlite3, or a remote query bridge all satisfy it).
 *
 * Streams per-session instead of preloading every message+part: real databases
 * reach multiple GB.
 */
export async function opencodeSessionsFromDb(db: SqliteDb, opts: OpencodeOptions): Promise<NirSession[]> {
  const sessions = (await db
    .prepare(
      `SELECT ${await sessionColumns(db)} FROM session s LEFT JOIN project p ON p.id = s.project_id`,
    )
    .all()) as SessionRow[];
  const { msgStmt, partStmt } = prepareMessageStmts(db);

  const out: NirSession[] = [];
  for (const row of sessions) {
    const session = await mapSessionRow(row, msgStmt, partStmt, opts);
    if (session) out.push(session);
  }
  return out;
}

/**
 * Map a single opencode session to NIR, querying only that session's rows.
 * Use this over bridges (SSH/WSL) where the whole-DB scan costs one remote
 * round-trip per message of every other session. Returns null when the
 * session id is not found (or it has no parseable messages).
 */
export async function opencodeSessionFromDb(
  db: SqliteDb,
  sessionId: string,
  opts: OpencodeOptions,
): Promise<NirSession | null> {
  const rows = (await db
    .prepare(
      `SELECT ${await sessionColumns(db)} FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?`,
    )
    .all(sessionId)) as SessionRow[];
  const row = rows[0];
  if (!row) return null;
  const { msgStmt, partStmt } = prepareMessageStmts(db);
  return mapSessionRow(row, msgStmt, partStmt, opts);
}

async function mapSessionRow(
  row: SessionRow,
  msgStmt: SqliteStatement,
  partStmt: SqliteStatement,
  opts: OpencodeOptions,
): Promise<NirSession | null> {
  const messages: NirMessage[] = [];
  const patchFiles = new Set<string>();
  const msgRows = (await msgStmt.all(row.id)) as { id: string; data: string; time_created: number }[];
  let model = row.model;

  for (const mr of msgRows) {
    let md: Record<string, unknown>;
    try {
      md = JSON.parse(mr.data);
    } catch {
      continue;
    }
    const role = md.role as string;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const modelField = md.model as Record<string, unknown> | undefined;
    const mModel = typeof modelField?.modelID === "string" ? modelField.modelID : model;
    if (typeof mModel === "string") model = mModel;
    const tsMs =
      typeof md.time === "object" && md.time !== null
        ? (md.time as Record<string, unknown>).created
        : mr.time_created;
    const ts = isoFromMs(tsMs as number);
    const tokensRaw = extractTokens(md.tokens);

    let textContent = "";
    const partRows = (await partStmt.all(mr.id)) as { data: string }[];
    for (const pr of partRows) {
      let pd: Record<string, unknown>;
      try {
        pd = JSON.parse(pr.data);
      } catch {
        continue;
      }
      const pt = pd.type as string;
      if (pt === "text" && typeof pd.text === "string") {
        textContent += (textContent ? "\n" : "") + pd.text;
      } else if (pt === "tool" && typeof pd.tool === "string") {
        const state = (pd.state ?? {}) as Record<string, unknown>;
        const callId = typeof pd.callID === "string" ? pd.callID : null;
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: pd.tool,
            toolInput: state.input ?? null,
            toolCallId: callId,
            timestamp: ts,
            model: mModel,
          }),
        );
        const output = state.output;
        const status = typeof state.status === "string" ? state.status : null;
        const errorText = typeof state.error === "string" ? state.error : null;
        if (typeof output === "string") {
          // opencode records the verdict structurally in `state.status`
          // ("completed" | "error" | "running") and carries the provider's
          // message in `state.error`. Measured on a real database: 2961
          // completed / 38 error / 1 running. Until 0.5.0 this was dropped, so
          // a failed tool and a successful one both arrived as bare text — and
          // an errored tool often has NO output at all, which is why regex
          // recovery measured ~0.2% on this source.
          messages.push(
            makeMsg({
              role: "tool",
              content: output,
              toolName: pd.tool,
              toolCallId: callId,
              timestamp: ts,
              ...(status !== null
                ? {
                    toolResult: {
                      status:
                        status === "error"
                          ? ("error" as const)
                          : status === "running"
                            ? ("unknown" as const)
                            : ("success" as const),
                      method: "source_status" as const,
                      errorText: errorText === null ? null : errorText.slice(0, 500),
                      detail: {},
                    },
                  }
                : {}),
            }),
          );
        } else if (status === "error" || errorText !== null) {
          // A failed tool frequently has no `output` at all — that is exactly the
          // case regex recovery could never see. Emit the message anyway so the
          // failure is not silently dropped from the transcript.
          messages.push(
            makeMsg({
              role: "tool",
              content: "",
              toolName: pd.tool,
              toolCallId: callId,
              timestamp: ts,
              toolResult: {
                status: "error" as const,
                method: "source_status" as const,
                errorText: errorText === null ? null : errorText.slice(0, 500),
                detail: {},
              },
            }),
          );
        }
      } else if (pt === "reasoning" && typeof pd.text === "string") {
        const thinking = pd.text.trim();
        if (thinking) {
          messages.push(
            makeMsg({
              role: role as NirMessage["role"],
              content: "",
              thinking,
              timestamp: ts,
              model: mModel,
            }),
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
  const hasRowTokens = !!(
    row.tokens_input ||
    row.tokens_output ||
    row.tokens_cache_read ||
    row.tokens_cache_write
  );
  const rowTokens = {
    input: row.tokens_input ?? 0,
    output: (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0),
    cacheRead: row.tokens_cache_read ?? 0,
    cacheWrite: row.tokens_cache_write ?? 0,
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
    ...(hasRowTokens ? { tokens: rowTokens } : {}),
    rawMeta: {
      title: row.title,
      cost: row.cost,
      additions: row.summary_additions,
      deletions: row.summary_deletions,
      filesChanged: row.summary_files,
      ...(patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {}),
    },
  });
  if (hasRowTokens && model) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant && !lastAssistant.tokens) {
      lastAssistant.tokens = rowTokens;
    }
  }
  return session;
}

