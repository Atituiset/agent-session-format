# agent-session-format

Environment-agnostic parsers that normalize AI coding-agent session transcripts
into one zod-validated intermediate representation (**NIR**). Extracted from
[agent-viewer](https://github.com/Atituiset/agent-viewer) and
[session-forge](https://github.com/Atituiset/session-forge) so both — and any
other tool — can share a single parsing implementation.

**Consumed by agent-viewer & session-forge.**

## The design rule: pure functions only

Nothing in `src/` touches the environment: no `fs`, `path`, `os`, no `bun:*`,
no network, no directory scanning. Every parser is a pure function:

- **input** — a string, lines, or already-open database rows (via an injected
  interface, see below);
- **output** — NIR objects validated by the zod schema in `src/schema.ts`.

All file I/O, path globs, SSH transports, and database opening stay in the
consuming app. The package runs unchanged in Node, Bun, and the browser.

## Format families

| Family | Sources | Layout | Entry point |
|---|---|---|---|
| `claude-code` | Claude Code | `~/.claude/projects/<slug>/*.jsonl` | `parseClaudeCodeTranscript(text, opts)` |
| `codex-family` | Codex CLI, DeepSeek (rollout JSONL) | rollout event stream | `parseCodexRollout(text, opts)` |
| `codex-family` | Kimi Code | `agents/<name>/wire.jsonl` event stream | `parseKimiWire(text, opts)` |
| `codex-family` | codewhale, DeepSeek (single-file JSON) | `{metadata, messages}` document | `parseSessionJsonDocument` / `parseCodewhaleSession(text, opts)` |
| `opencode-sqlite` | opencode | `opencode.db` (SQLite) | `opencodeSessionsFromDb(db, opts)` / `opencodeSessionFromDb(db, id, opts)` |
| `antigravity-transcript` | Gemini / Antigravity | `brain/<id>/.../transcript.jsonl` | `parseAntigravityTranscript(text, opts)` |
| `hermes` | Hermes | `request_dump_*.json` or `state.db` | `parseHermesDump(text, opts)` / `hermesSessionsFromDb(db, opts)` / `hermesSessionFromDb(db, id, opts)` |
| generic detection | unknown agents | any of the above | `detectKind(text)`, `parseDetectedTranscript(kind, text, opts)` |

`detectKind` classifies arbitrary transcript text (a whole file or a truncated
head) as `claude-style` / `codex-style` / `chat-style` / `session-style` —
content classification only, no directory scanning.

## Install

```sh
npm i github:Atituiset/agent-session-format
```

The package ships **both ESM and CJS** builds: `import` resolves to
`dist/index.js`, `require("agent-session-format")` (e.g. from a CommonJS
Electron main process) resolves to `dist/index.cjs`, with type declarations
for both. `dist/` is committed, so git-dependency installs work without
running build scripts.

## Usage

```ts
import { readFileSync } from "node:fs";
import { parseClaudeCodeTranscript, detectKind, parseDetectedTranscript } from "agent-session-format";

// Known format: parse directly.
const session = parseClaudeCodeTranscript(readFileSync("session.jsonl", "utf8"), {
  source: "claude-code",        // recorded as session.source
  filePath: "session.jsonl",    // used to derive the id (and the Claude project slug)
});

// Unknown format: classify first, then dispatch.
const kind = detectKind(headSample);           // "claude-style" | "codex-style" | ... | null
if (kind) parseDetectedTranscript(kind, text, { source: "my-agent", id: "run-1" });
```

Parsers return `null` when nothing parseable is found, and never throw on
corrupt transcript *content* (bad lines/rows are skipped). They throw only on
missing *options* (no derivable session id).

## The NIR model

`NirSession` (zod: `nirSessionSchema`):

- `id`, `source`, `sourceVersion`, `projectPath`, `startedAt`, `endedAt`
- `title`, `model`, `cost`, `tokens` — optional session-level extensions
- `messages: NirMessage[]` — one message per event: `role`
  (`user | assistant | tool | system`), `content`, `timestamp`, `thinking`,
  `model`, `tokens`, and tool-call detail: `toolName`, `toolInput`,
  `toolCallId` (correlates an assistant tool call with its `role: "tool"`
  result message), plus `agent` / `agentLabel` swimlane tags for subagent
  lanes.
- `rawMeta` — source-specific extras (patch file lists, sidechain counts,
  estimated tokens, …).

## Injected SQLite (opencode, hermes state.db)

The package never opens a database. It defines a minimal interface —

```ts
interface SqliteStatement { all(...params: unknown[]): unknown[] | Promise<unknown[]> }
interface SqliteDb { prepare(sql: string): SqliteStatement }
```

— and does SQL → NIR mapping only. `all` results are `await`ed, so synchronous
drivers (Bun, better-sqlite3) and asynchronous ones (remote query bridges) both
work unchanged.

**Bun consumer:**

```ts
import { Database } from "bun:sqlite";
import { opencodeSessionsFromDb } from "agent-session-format";

const db = new Database("/home/me/.local/share/opencode/opencode.db", { readonly: true });
const sessions = await opencodeSessionsFromDb(db, { source: "opencode" });
```

**Node consumer (better-sqlite3):**

```ts
import Database from "better-sqlite3";
import { opencodeSessionsFromDb } from "agent-session-format";

const db = new Database("/home/me/.local/share/opencode/opencode.db", { readonly: true });
const sessions = await opencodeSessionsFromDb(db, { source: "opencode" });
```

**Async bridge consumer** (e.g. a remote/WSL query path):

```ts
const db = {
  prepare: (sql: string) => ({
    all: (...params: unknown[]) => queryRemoteSqlite(dbPath, sql, params), // Promise<rows>
  }),
};
const sessions = await opencodeSessionsFromDb(db, { source: "opencode" });
```

**Single-session reads:** when you only need one session, prefer the
per-session variants — every query is filtered by session id, which over a
remote bridge avoids one round-trip per message of every *other* session.
They return the same NIR shape as the whole-DB variants, or `null` when the
session id is not found:

```ts
import { opencodeSessionFromDb, hermesSessionFromDb } from "agent-session-format";

const one = await opencodeSessionFromDb(db, "ses_abc123", { source: "opencode" });
const hermes = await hermesSessionFromDb(db, "20260602_233910_562888", { source: "hermes" });
```

## Development

```sh
npm install     # also builds dist/ via the prepare script
npm run build   # tsup → ESM + .d.ts in dist/
npm test        # vitest
npm run typecheck
```

`dist/` is committed to git on purpose: installs via a git dependency
(`npm i github:Atituiset/agent-session-format`, or a Bun git install) work
without running build scripts, and the `prepare` script covers the cases where
they do run.

## License

MIT
