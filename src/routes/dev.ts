/**
 * Endpoints used only by the fake-WhatsApp harness.
 *
 * Every route here refuses to run unless DEV_MODE is on — they inject
 * unauthenticated inbound messages, which would be a trivial way to spoof trips
 * if they were ever reachable in production.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { isDevMode } from "../env";
import { DevOutboxTransport } from "../adapters/whatsapp/transport";
import { createFlowContext, handleInbound } from "../domain/flow";
import type { InboundPayload } from "../domain/types";
import { sweepStuckState } from "../domain/sweep";

export const devRoutes = new Hono<{ Bindings: Env }>();

devRoutes.use("*", async (c, next) => {
  if (!isDevMode(c.env)) return c.text("not found", 404);
  await next();
});

/** Inject a synthetic inbound message, exactly as if it arrived from Meta. */
devRoutes.post("/inbound", async (c) => {
  const body = await c.req.json<{
    from: string;
    payload: InboundPayload;
    /** Optional clock override, so tests can fast-forward. */
    now?: number;
  }>();

  const now = body.now ?? Date.now();
  const ctx = createFlowContext(c.env.DB, new DevOutboxTransport(c.env.DB, now), now);

  await handleInbound(ctx, {
    from: body.from,
    // Unique per injection so the dedup gate never swallows a harness message.
    messageId: `dev-${now}-${Math.random().toString(36).slice(2, 10)}`,
    at: now,
    payload: body.payload,
  });

  return c.json({ ok: true });
});

/** Poll for messages the bot has sent to a number since a given outbox id. */
devRoutes.get("/outbox", async (c) => {
  const phone = c.req.query("phone");
  const since = Number(c.req.query("since") ?? 0);
  if (!phone) return c.json({ error: "phone required" }, 400);

  const { results } = await c.env.DB.prepare(
    "SELECT id, phone, spec_json, at FROM dev_outbox WHERE phone = ? AND id > ? ORDER BY id",
  )
    .bind(phone, since)
    .all<{ id: number; phone: string; spec_json: string; at: number }>();

  return c.json({
    messages: results.map((r) => ({
      id: r.id,
      at: r.at,
      spec: JSON.parse(r.spec_json),
    })),
  });
});

/** Live snapshot for the harness sidebar: drivers, trips, and the queue. */
devRoutes.get("/state", async (c) => {
  const [drivers, trips] = await Promise.all([
    c.env.DB.prepare(
      `SELECT d.id, d.phone, d.name, d.tuktuk_no, d.status, d.available_at,
              z.name AS zone_name, pz.name AS projected_zone_name
       FROM drivers d
       LEFT JOIN zones z  ON z.id  = d.zone_id
       LEFT JOIN zones pz ON pz.id = d.projected_zone_id
       WHERE d.active = 1 ORDER BY d.id`,
    ).all(),
    c.env.DB.prepare(
      `SELECT t.id, t.source, t.customer_phone, t.state, t.dest_label,
              t.quoted_wait_min, t.requested_at, t.done_at,
              d.name AS driver_name, z.name AS pickup_zone_name
       FROM trips t
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN zones z   ON z.id = t.pickup_zone_id
       ORDER BY t.id DESC LIMIT 25`,
    ).all(),
  ]);

  return c.json({ drivers: drivers.results, trips: trips.results });
});

/** Wipe conversational state without touching the gazetteer. */
devRoutes.post("/reset", async (c) => {
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dev_outbox"),
    c.env.DB.prepare("DELETE FROM events"),
    c.env.DB.prepare("DELETE FROM sessions"),
    c.env.DB.prepare("DELETE FROM status_events"),
    c.env.DB.prepare("DELETE FROM trips"),
    c.env.DB.prepare(
      `UPDATE drivers SET status = CASE WHEN status = 'off' THEN 'off' ELSE 'available' END,
                          projected_zone_id = zone_id, available_at = 0,
                          idle_since = ?, updated_at = ?`,
    ).bind(now, now),
  ]);
  return c.json({ ok: true });
});

/** Run the cron sweep on demand, instead of waiting for the next minute. */
devRoutes.post("/sweep", async (c) => {
  const now = Number(c.req.query("now") ?? Date.now());
  const ctx = createFlowContext(c.env.DB, new DevOutboxTransport(c.env.DB, now), now);
  await sweepStuckState(ctx);
  return c.json({ ok: true });
});

/**
 * Landmarks with coordinates, for the harness's location picker — so "send
 * location" is one click on a real place rather than typing lat/lng by hand.
 */
devRoutes.get("/places", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.lat, l.lng, z.name AS zone_name
     FROM landmarks l JOIN zones z ON z.id = l.zone_id
     WHERE l.active = 1 AND l.lat IS NOT NULL
     ORDER BY z.sort_order, l.sort_order`,
  ).all<{ id: string; name: string; lat: number; lng: number; zone_name: string }>();
  return c.json({ places: results });
});

/** The roster the harness offers as "who am I?" personas. */
devRoutes.get("/personas", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT phone, name, tuktuk_no FROM drivers WHERE active = 1 ORDER BY id",
  ).all<{ phone: string; name: string; tuktuk_no: string | null }>();
  return c.json({ drivers: results });
});
