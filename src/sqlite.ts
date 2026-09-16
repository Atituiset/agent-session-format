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
export interface SqliteStatement {
  all(...params: unknown[]): unknown[] | Promise<unknown[]>;
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
}
