export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;

  /** "true" routes outbound messages to dev_outbox instead of Meta. */
  DEV_MODE: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_API_VERSION: string;

  /** Secrets — set with `wrangler secret put`. */
  WHATSAPP_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
};

export const isDevMode = (env: Env) => env.DEV_MODE === "true";
