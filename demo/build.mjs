/**
 * The handout: `demo/dist/index.html`, one file, no network, no server.
 *
 * ── What this has to defeat ───────────────────────────────────────────────────
 *
 * A page opened by double-clicking it runs on `file://`, where the document's
 * origin is opaque. Three things follow, and all three are why this script exists
 * rather than a copy of `index.html` next to the bundle:
 *
 *   1. `<script type="module" src="./main.js">` is fetched, and a module fetch
 *      from an opaque origin is a CORS failure. The page loads and nothing runs.
 *      Bundling to an IIFE and inlining it means there is no fetch to fail. (An
 *      inline module would probably also work; not having to know is worth more
 *      than the module syntax, which nothing here uses at runtime.)
 *   2. `<link rel="stylesheet">` is a fetch too. Same answer.
 *   3. sql.js wants its `.wasm`, and a fetch for a sibling file is blocked
 *      outright. The bytes are handed to `initSqlJs` as base64 instead — which
 *      `demo:dev` already does, so a WASM problem cannot appear for the first time
 *      in the thing being handed out.
 *
 * The seed is a `*.sql` text import and the migrations are enumerated by
 * `bundle.mjs`, so esbuild has already turned every file in `migrations/` and
 * `seeds/dev.sql` into string literals inside the bundle by the time this file
 * sees it. The handout therefore carries the app's real schema — all of it,
 * including migrations added after this script was written — and not a copy.
 *
 * Nothing is fetched at runtime and nothing may be: there is no favicon request
 * either, which `index.html` heads off with an empty `data:` icon. The result is
 * about 1.3 MB, nearly all of it the SQLite engine, and that is the price of a
 * page that works in a town with no internet.
 *
 * ── The two markers ───────────────────────────────────────────────────────────
 *
 * The dev shell's `<link>` and `<script src>` are found by exact text and
 * replaced. A silent miss would ship a handout that still points at two sibling
 * files and shows a blank page on the USB stick it was carried on, so both are
 * asserted and the build fails loudly instead.
 *
 * `npm run demo:build`. `npm run demo:dev` is unaffected and still serves the
 * unbundled pair.
 */

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOADERS, migrationsPlugin } from "./bundle.mjs";

const DEMO = dirname(fileURLToPath(import.meta.url));
const OUT = join(DEMO, "dist", "index.html");

/** Exactly as written in `demo/index.html`. Change one and this script fails. */
const STYLE_MARKER = '<link rel="stylesheet" href="./dist/main.css">';
const SCRIPT_MARKER = '<script type="module" src="./dist/main.js"></script>';

const result = await build({
  entryPoints: [join(DEMO, "src", "main.ts")],
  bundle: true,
  // Not ESM. See the note at the top: a classic script has nothing to fetch, so
  // the `file://` question never arises.
  format: "iife",
  target: "es2022",
  minify: true,
  // Default `charset: "ascii"`, deliberately left alone: every non-ASCII
  // character in `copy.ts` comes out as an escape, so the page cannot be broken
  // by a machine that opens the file with the wrong encoding assumption.
  // Shared with every other bundle the demo produces, along with the plugin that
  // reads `migrations/` — see `bundle.mjs` for why that cannot be a static list.
  loader: LOADERS,
  plugins: [migrationsPlugin()],
  // The handout is a thing somebody reads, not debugs; a map would double its
  // size and point at sources that are not in the file.
  sourcemap: false,
  write: false,
  outdir: join(DEMO, "dist"),
  logLevel: "warning",
});

const js = only(result.outputFiles, ".js");
const css = only(result.outputFiles, ".css");

let html = readFileSync(join(DEMO, "index.html"), "utf8");
html = swap(html, STYLE_MARKER, `<style>\n${css}\n</style>`);
// `</script>` inside a string literal in the bundle would close this tag early.
// esbuild has no reason to emit one, but "no reason to" is not "cannot", and the
// failure would be a blank page with a parse error nobody expects in minified
// output.
html = swap(html, SCRIPT_MARKER, `<script>\n${js.replaceAll("</script", "<\\/script")}\n</script>`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const bytes = Buffer.byteLength(html);
console.log(`demo/dist/index.html  ${(bytes / 1024 / 1024).toFixed(2)} MB  — open it by double-clicking`);

function only(files, extension) {
  const found = files.filter((f) => f.path.endsWith(extension));
  if (found.length !== 1) {
    throw new Error(`demo build: expected one ${extension} from esbuild, got ${found.length}`);
  }
  return found[0].text;
}

function swap(haystack, marker, replacement) {
  if (!haystack.includes(marker)) {
    throw new Error(
      `demo build: demo/index.html no longer contains\n  ${marker}\n` +
        "so the built page would still fetch it from a sibling file and show nothing " +
        "on file://. Fix the marker in demo/build.mjs to match.",
    );
  }
  return haystack.replace(marker, () => replacement);
}
