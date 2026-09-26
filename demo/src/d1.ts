/**
 * A `D1Database` over sql.js, so the browser demo can run `src/domain` unchanged.
 *
 * Only the slice the domain actually calls is real: `prepare()`, `.bind()`,
 * `.first()`, `.all()`, `.run()`. Everything else on the D1 surface throws.
 * That is the point — a half-working `batch()` would let a future demo take a
 * code path the Worker does not have, and the whole reason for reusing the
 * domain is that the demo cannot misrepresent the app.
 *
 * Four details decide whether the demo *behaves* like production or merely
 * looks like it:
 *
 *   - Foreign keys are off by default in sql.js and enforced in D1.
 *   - `meta.changes` is the entirety of `claimDriver`'s race handling and of the
 *     webhook dedup gate, so it is read from sqlite3_changes() with nothing
 *     touching the connection in between.
 *   - `meta.last_row_id` is how `createHail` returns a trip id.
 *   - `.first()` must be `null` and never `undefined`; the domain branches on
 *     `null` in a dozen places and `undefined` would sail through some of them.
 */

import type { Database as SqliteDatabase, SqlValue, Statement } from "sql.js";

/** One statement's outcome, before it is dressed up as a D1 result. */
type Execution = {
  rows: Record<string, SqlValue>[];
  changes: number;
  lastRowId: number;
};

const LAST_ROW_ID_SQL = "SELECT last_insert_rowid() AS id";

export class SqlJsD1Database implements D1Database {
  /**
   * The connection underneath, for demo-only reads. The map needs fleet
   * positions and the zone-time strip needs the matrix, and neither of those is
   * a domain concern — but writes must still go through the domain (R2), so
   * anything reaching for this to UPDATE is a bug.
   */
  readonly sqlite: SqliteDatabase;

  /**
   * Prepared statements, keyed by SQL text. The domain's query set is small and
   * fixed — `rankCandidates` builds the only dynamic SQL, in two shapes — so
   * this is a bounded cache and not a leak. Reuse is safe because sql.js's
   * `bind` resets first, and because every statement runs to completion inside
   * one synchronous block: two executions of the same SQL can never interleave.
   */
  private readonly statements = new Map<string, Statement>();

  constructor(sqlite: SqliteDatabase) {
    this.sqlite = sqlite;
    // D1 enforces foreign keys; sql.js does not unless asked. Skipping this
    // would make the demo quietly more forgiving than production, so a trip
    // pointing at a zone that does not exist would only fail after deploy.
    sqlite.run("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    return new SqlJsD1Statement(this, query, []);
  }

  batch(): never {
    return notImplemented("batch()");
  }

  exec(): never {
    // Schema and seed are applied through `sqlite.run` in db.ts. Routing them
    // here instead would look right and then fail on the second statement.
    return notImplemented("exec()");
  }

  withSession(): never {
    return notImplemented("withSession()");
  }

  dump(): never {
    return notImplemented("dump()");
  }

  /** Runs one statement to completion and reports exactly what D1 reports. */
  execute(query: string, params: readonly SqlValue[]): Execution {
    const stmt = this.statementFor(query);
    try {
      stmt.bind(params as SqlValue[]);

      const rows: Record<string, SqlValue>[] = [];
      // Drained rather than stepped once: a single step would leave a cached
      // statement half-open, and the next caller would resume mid-result.
      while (stmt.step()) rows.push(stmt.getAsObject());

      // Read here, before anything else touches the connection. `claimDriver`
      // and the dedup gate are nothing but this number.
      const changes = this.sqlite.getRowsModified();

      return { rows, changes, lastRowId: this.lastRowId() };
    } finally {
      // Releases the statement's bound-parameter buffers and its read lock. A
      // scripted hour is tens of thousands of statements through one WASM heap.
      stmt.reset();
    }
  }

  /** Frees the WASM-side statements. The demo page reopens rather than reuses. */
  close(): void {
    for (const stmt of this.statements.values()) stmt.free();
    this.statements.clear();
    this.sqlite.close();
  }

  /**
   * SQLite's last-insert rowid is sticky: it survives statements that insert
   * nothing, which is exactly D1's behaviour. Deliberately not zeroed for
   * non-inserts — the domain only reads it straight after a successful INSERT,
   * and inventing a reset would be a divergence with nothing to check it
   * against.
   */
  private lastRowId(): number {
    const stmt = this.statementFor(LAST_ROW_ID_SQL);
    try {
      stmt.step();
      const id = stmt.get()[0];
      return typeof id === "number" ? id : 0;
    } finally {
      stmt.reset();
    }
  }

  private statementFor(query: string): Statement {
    const cached = this.statements.get(query);
    if (cached) return cached;
    const stmt = this.sqlite.prepare(query);
    this.statements.set(query, stmt);
    return stmt;
  }
}

class SqlJsD1Statement implements D1PreparedStatement {
  constructor(
    private readonly db: SqlJsD1Database,
    private readonly query: string,
    private readonly params: readonly SqlValue[],
  ) {}

  /**
   * D1 hands back a new statement instead of mutating the prepared one, so a
   * bound statement stays valid however often it is used. Keeping that property
   * is what lets the domain hold one and run it later.
   */
  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlJsD1Statement(this.db, this.query, bindValues(this.query, values));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const { rows } = this.db.execute(this.query, this.params);
    const row = rows[0];
    if (!row) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`demo D1 shim: no column named "${colName}"`);
    return row[colName] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { rows, changes, lastRowId } = this.db.execute(this.query, this.params);
    return { success: true, results: rows as T[], meta: meta(changes, lastRowId) };
  }

  /**
   * Identical to `all()`, as it is in D1: a write returns no rows and a RETURNING
   * clause returns them either way. Only the caller's intent differs.
   */
  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  raw(): never {
    return notImplemented("raw()");
  }
}

function meta(changes: number, lastRowId: number): D1Meta & Record<string, unknown> {
  return {
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    rows_written: changes,
    // Reported by D1 from its own accounting; nothing in src/ reads them, and a
    // plausible-looking guess would be worse than an obvious zero.
    rows_read: 0,
    size_after: 0,
    // Not measured on purpose: a wall-clock read here is the one thing that
    // would make an otherwise replayable hour differ run to run (R4).
    duration: 0,
  };
}

/**
 * D1 rejects `undefined` parameters, and so must the shim. The domain writes
 * `?? null` everywhere precisely because of this, so an `undefined` arriving
 * here means a demo-side bug — and sql.js's own complaint is a bare string with
 * no SQL in it, which is a bad afternoon.
 */
function bindValues(query: string, values: unknown[]): SqlValue[] {
  return values.map((value, i) => {
    if (value === undefined) {
      throw new Error(`demo D1 shim: parameter ${i + 1} is undefined in: ${query}`);
    }
    // D1 stores booleans as 1/0; being explicit keeps that out of sql.js's
    // type-guessing.
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as SqlValue;
  });
}

function notImplemented(method: string): never {
  throw new Error(
    `demo D1 shim: ${method} is not implemented — nothing in src/domain calls it, ` +
      `so the demo would be exercising a path the Worker does not have`,
  );
}
