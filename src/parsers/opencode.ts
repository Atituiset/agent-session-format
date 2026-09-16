import type { NirMessage, NirSession } from "../schema.js";
import type { SqliteDb } from "../sqlite.js";
import { buildSession, isoFromMs, makeMsg } from "../util.js";

const MAX_TEXT = 30_000;

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
  worktree: string | null;
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
      `SELECT s.id, s.directory, s.title, s.version, s.summary_additions, s.summary_deletions,
              s.summary_files, s.time_created, s.time_updated, s.model, s.cost,
              s.tokens_input, s.tokens_output, p.worktree
       FROM session s LEFT JOIN project p ON p.id = s.project_id`,
    )
    .all()) as SessionRow[];
  const msgStmt = db.prepare(
    "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created",
  );
  const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created");

  const out: NirSession[] = [];
  for (const row of sessions) {
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
      const tokensRaw = extractOpencodeTokens(md.tokens);

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
          if (typeof output === "string") {
            messages.push(
              makeMsg({
                role: "tool",
                content: output.slice(0, MAX_TEXT),
                toolName: pd.tool,
                toolCallId: callId,
                timestamp: ts,
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
      textContent = textContent.trim().slice(0, MAX_TEXT);
      if (!textContent) continue;
      const msg = makeMsg({ role, content: textContent, timestamp: ts, model: mModel });
      if (tokensRaw) msg.tokens = { ...tokensRaw, cacheRead: 0, cacheWrite: 0 };
      messages.push(msg);
    }

    if (messages.length === 0) continue;
    const hasRowTokens = !!(row.tokens_input || row.tokens_output);
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
      ...(hasRowTokens
        ? {
            tokens: {
              input: row.tokens_input ?? 0,
              output: row.tokens_output ?? 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }
        : {}),
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
        lastAssistant.tokens = {
          input: row.tokens_input ?? 0,
          output: row.tokens_output ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
    }
    out.push(session);
  }
  return out;
}

function extractOpencodeTokens(v: unknown): { input: number; output: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const input = o.input ?? o.inputs;
  const output = o.output ?? o.outputs;
  if (typeof input === "number" || typeof output === "number") {
    return {
      input: typeof input === "number" ? input : 0,
      output: typeof output === "number" ? output : 0,
    };
  }
  return undefined;
}
