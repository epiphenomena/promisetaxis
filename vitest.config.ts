import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Migrations are read once here and handed to each test through a binding, so
// every test starts from the real schema rather than a hand-maintained copy.
const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        // Per-test D1 state, rolled back automatically. This is what lets the
        // dispatch race test fire concurrent claims without cross-contamination.
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_MODE: "true",
            WHATSAPP_PHONE_NUMBER_ID: "test-number-id",
            WHATSAPP_API_VERSION: "v21.0",
            WHATSAPP_TOKEN: "test-token",
            WHATSAPP_APP_SECRET: "test-secret",
            WHATSAPP_VERIFY_TOKEN: "test-verify",
          },
        },
      },
    },
  },
});
