/**
 * The one place that knows how demo code is bundled.
 *
 * ── Why this exists rather than six esbuild command lines ─────────────────────
 *
 * `demo/src/db.ts` has to apply *every* file in `migrations/`, in order, and keep
 * doing so when `0003` lands. A static list of text imports cannot: somebody adds
 * a migration, the app's schema moves, and the demo carries on against the old one
 * — which is not a compile error, not a typecheck error, and on screen is the
 * domain throwing on a column the demo's SQLite has never heard of. That is
 * exactly how `0002_trip_approach_min.sql` broke every trip in the demo.
 *
 * Enumerating the directory needs a plugin, and the esbuild *CLI* cannot load
 * plugins — so every bundle the demo produces has to go through esbuild's JS API,
 * and therefore through here. The npm scripts, `verify-phase{4,5}`'s page build
 * and `build.mjs` all call this file instead of spelling out loaders and flags of
 * their own, which is also how `.sql`/`.wasm` stopped being repeated in seven
 * places that could disagree.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node demo/bundle.mjs harness demo/verify-phase1.ts demo/dist/verify-phase1.mjs
 *   node demo/bundle.mjs page            → demo/dist/main.{js,css}, ESM, for a page
 *   node demo/bundle.mjs serve           → the same, watched and served on :8000
 *
 * `build.mjs` imports `LOADERS` and `migrationsPlugin` directly, because the
 * handout is an IIFE with its output inlined rather than written.
 */

import { build, context } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEMO = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEMO);
const MIGRATIONS_DIR = join(ROOT, "migrations");

/**
 * Shared by every bundle here.
 *
 * `.sql` as text is what puts the app's own schema and seed inside the demo
 * rather than a copy that rots. `.wasm` as base64 and not as a URL is what lets
 * the handout open from `file://`, where a fetch for a sibling file is blocked.
 */
export const LOADERS = { ".sql": "text", ".wasm": "base64" };

/** The module specifier `db.ts` imports. Not a file; see `migrationsPlugin`. */
export const MIGRATIONS_MODULE = "virtual:migrations";

/**
 * Turn `migrations/*.sql` into one module, read at bundle time.
 *
 * Sorted by filename, which is the order wrangler applies them in, so the demo's
 * database is built by the same sequence of statements as the deployed one.
 *
 * The name check is not decoration: a file that does not sort by its number would
 * be applied out of order, and something like `0002.backup.sql` would be applied
 * *twice over* — both of which produce a schema that no `d1 migrations apply`
 * would ever have created. Better to refuse to build.
 */
export function migrationsPlugin() {
  return {
    name: "demo-migrations",
    setup(build) {
      const filter = new RegExp(`^${MIGRATIONS_MODULE}$`);
      build.onResolve({ filter }, () => ({ path: MIGRATIONS_MODULE, namespace: "migrations" }));

      build.onLoad({ filter: /.*/, namespace: "migrations" }, () => {
        const names = readdirSync(MIGRATIONS_DIR)
          .filter((name) => name.endsWith(".sql"))
          .sort();

        if (names.length === 0) {
          throw new Error(`demo bundle: ${MIGRATIONS_DIR} has no .sql files to apply`);
        }
        for (const name of names) {
          if (!/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(name)) {
            throw new Error(
              `demo bundle: migrations/${name} is not named NNNN_name.sql, so the order ` +
                `the demo would apply it in is not the order wrangler would`,
            );
          }
        }

        const files = names.map((name) => ({
          name,
          sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
        }));

        return {
          contents: `export const MIGRATIONS = ${JSON.stringify(files)};`,
          loader: "js",
          // Both, so `serve` rebuilds for an edit to a migration *and* for a new
          // one appearing — a directory listing is part of this module's input.
          watchFiles: names.map((name) => join(MIGRATIONS_DIR, name)),
          watchDirs: [MIGRATIONS_DIR],
        };
      });
    },
  };
}

/** A verification harness: one node-hosted ESM file, dependencies left alone. */
function harnessOptions(entry, outfile) {
  return {
    entryPoints: [join(ROOT, entry)],
    outfile: join(ROOT, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: LOADERS,
    plugins: [migrationsPlugin()],
    logLevel: "warning",
  };
}

/** The page, as `demo/index.html` loads it: ESM plus a sibling stylesheet. */
function pageOptions({ sourcemap }) {
  return {
    entryPoints: [join(DEMO, "src", "main.ts")],
    outdir: join(DEMO, "dist"),
    bundle: true,
    format: "esm",
    target: "es2022",
    loader: LOADERS,
    plugins: [migrationsPlugin()],
    sourcemap,
    logLevel: "warning",
  };
}

// Nothing runs when this file is merely imported — `build.mjs` wants the plugin
// and the loaders, not a second bundle written over the one it is about to make.
const [command, ...rest] = process.argv.slice(2);

if (command === "harness") {
  const [entry, outfile] = rest;
  if (!entry || !outfile) throw new Error("demo bundle: harness needs <entry> <outfile>");
  await build(harnessOptions(entry, outfile));
} else if (command === "page") {
  await build(pageOptions({ sourcemap: false }));
} else if (command === "serve") {
  // Sourcemaps only here: they are for whoever is working on the demo, and the
  // harnesses compare bundles rather than read them.
  const ctx = await context(pageOptions({ sourcemap: true }));
  await ctx.watch();
  const { host, port } = await ctx.serve({ servedir: DEMO, host: "127.0.0.1", port: 8000 });
  console.log(`demo → http://${host}:${port}/index.html  (watching)`);
} else if (command !== undefined) {
  throw new Error(`demo bundle: unknown command "${command}" — expected harness, page or serve`);
}
