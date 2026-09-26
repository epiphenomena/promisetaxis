import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/env";

// Augments the `cloudflare:test` types the pool already ships — declaring the
// module from scratch here would shadow its `env` and `applyD1Migrations`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
