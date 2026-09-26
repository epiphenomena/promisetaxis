/**
 * The ambient `D1Database` family, without the rest of the Workers runtime.
 *
 * `@cloudflare/workers-types` cannot be a global `types` entry here. It declares
 * HTMLRewriter's `Element` as a global class, and a class member shadows the
 * inherited interface member of the same name — so with `lib: ["DOM"]` also
 * loaded, `element.append(node)` resolves to HTMLRewriter's
 * `append(content: string | Response | ReadableStream)` and every line of DOM
 * construction in `phone.ts` fails to typecheck. The same collision hits
 * `prepend`, `before`, `after` and `remove`.
 *
 * So the four types the shim and the domain actually need are pulled out of the
 * package's module form and re-exposed globally, and the browser keeps its own
 * `Response`, `fetch` and `Element` — which is the correct set for code that runs
 * in a page. They are the real declarations, not hand-copied approximations: the
 * whole claim of `d1.ts` is that `src/domain` cannot tell the shim from the
 * binding, and checking it against a paraphrase would quietly retire that claim.
 *
 * The `.ts` in the specifier is the package's own module entry point — there is no
 * `.d.ts` beside it — and is permitted because this project is `noEmit`.
 */

import type {
  D1Database as CfD1Database,
  D1Meta as CfD1Meta,
  D1PreparedStatement as CfD1PreparedStatement,
  D1Result as CfD1Result,
} from "@cloudflare/workers-types/index.ts";

declare global {
  type D1Database = CfD1Database;
  type D1PreparedStatement = CfD1PreparedStatement;
  type D1Result<T = unknown> = CfD1Result<T>;
  type D1Meta<T = unknown> = CfD1Meta<T>;
}
