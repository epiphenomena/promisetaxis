/**
 * A fresh demo database: the real schema, then a seed.
 *
 * Every file in `migrations/` arrives as text at bundle time, in the order
 * wrangler would apply them, plus `seeds/dev.sql` — so the demo cannot drift onto
 * a stale schema. Editing a migration changes what the demo runs and nobody has
 * to remember to copy anything.
 *
 * The list is *enumerated* rather than written out, which is the whole point:
 * `0002_trip_approach_min.sql` added a column `markDriverUnderway` writes on every
 * trip, and a demo pinned to `0001` threw on all of them. That failure is invisible
 * to both typecheckers and only shows up at runtime, so the schema the demo opens
 * has to be a directory listing and not a decision. See `demo/bundle.mjs`.
 *
 * The seed is a parameter so a later phase can hand in a richer town (more
 * drivers, surveyed landmarks) without touching the shim or this function.
 */

import type { SqlJsStatic } from "sql.js";
import { MIGRATIONS } from "virtual:migrations";
import devSeedSql from "../../seeds/dev.sql";
import { SqlJsD1Database } from "./d1";

export type SqlSources = {
  /** `migrations/*.sql`, in the order they must be applied. */
  migrations: readonly { name: string; sql: string }[];
  seedSql: string;
};

/** What the Worker runs against in local development. */
export const REAL_SQL: SqlSources = { migrations: MIGRATIONS, seedSql: devSeedSql };

export function openDemoDb(SQL: SqlJsStatic, sources: SqlSources = REAL_SQL): SqlJsD1Database {
  const db = new SqlJsD1Database(new SQL.Database());
  // Applied through sql.js directly rather than through the shim: these are
  // multi-statement scripts, and D1's `prepare` takes exactly one statement.
  //
  // One at a time and in order, because a migration is a diff against the
  // previous one: `ALTER TABLE` on a table a later file creates fails, and a
  // failure here surfaces as a missing column halfway through the hour.
  for (const migration of sources.migrations) {
    try {
      db.sqlite.run(migration.sql);
    } catch (cause) {
      throw new Error(`demo db: migrations/${migration.name} failed to apply`, { cause });
    }
  }
  db.sqlite.run(sources.seedSql);
  return db;
}
