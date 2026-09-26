import { Hono } from "hono";
import type { Env } from "./env";
import { isDevMode } from "./env";
import { parseInbound } from "./adapters/whatsapp/inbound";
import { handleVerification, verifySignature } from "./adapters/whatsapp/verify";
import {
  CloudApiTransport,
  DevOutboxTransport,
} from "./adapters/whatsapp/transport";
import type { Transport } from "./domain/types";
import { createFlowContext, handleInbound } from "./domain/flow";
import { sweepStuckState } from "./domain/sweep";
import { devRoutes } from "./routes/dev";
import { apiRoutes } from "./routes/api";
import harnessHtml from "./harness.html";

const app = new Hono<{ Bindings: Env }>();

function transportFor(env: Env, now: number): Transport {
  return isDevMode(env)
    ? new DevOutboxTransport(env.DB, now)
    : new CloudApiTransport(
        env.WHATSAPP_PHONE_NUMBER_ID,
        env.WHATSAPP_TOKEN,
        env.WHATSAPP_API_VERSION,
      );
}

/** Meta's one-time handshake when you save the webhook URL in the dashboard. */
app.get("/wa", (c) => {
  const result = handleVerification(new URL(c.req.url), c.env.WHATSAPP_VERIFY_TOKEN);
  return result.ok ? c.text(result.challenge) : c.text("forbidden", 403);
});

app.post("/wa", async (c) => {
  const raw = await c.req.text();

  const valid = await verifySignature(
    raw,
    c.req.header("x-hub-signature-256") ?? null,
    c.env.WHATSAPP_APP_SECRET,
  );
  if (!valid) return c.text("bad signature", 401);

  // Always 200 quickly. Meta retries anything else, and the dedup gate in
  // handleInbound makes a duplicate delivery harmless rather than destructive.
  const now = Date.now();
  const ctx = createFlowContext(c.env.DB, transportFor(c.env, now), now);

  let events;
  try {
    events = parseInbound(JSON.parse(raw));
  } catch {
    return c.text("ok");
  }

  c.executionCtx.waitUntil(
    (async () => {
      for (const event of events) {
        try {
          await handleInbound(ctx, event);
        } catch (err) {
          console.error("handleInbound failed", event.messageId, err);
        }
      }
    })(),
  );

  return c.text("ok");
});

app.route("/api", apiRoutes);
app.route("/dev", devRoutes);

app.get("/health", (c) => c.json({ ok: true, dev: isDevMode(c.env) }));

// The fake-WhatsApp harness drives the /dev/* message-injection routes, so it
// must not be reachable in production. It is bundled as text rather than kept
// in ./public precisely so this gate cannot be bypassed: static assets are
// served before the Worker runs, so an asset could never be gated at all.
app.get("/harness*", (c) =>
  isDevMode(c.env)
    ? c.html(harnessHtml)
    : c.text("not found", 404),
);

// Everything else is the office dashboard and its assets, gated at the edge by
// Cloudflare Access rather than by anything in this Worker.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  /** One-minute sweep for conversations and trips that got stuck. */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const now = Date.now();
    const ctx = createFlowContext(env.DB, transportFor(env, now), now);
    await sweepStuckState(ctx);
  },
} satisfies ExportedHandler<Env>;
