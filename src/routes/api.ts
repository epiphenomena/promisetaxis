/**
 * Office dashboard API.
 *
 * No auth code here on purpose: this Worker is protected at the edge by
 * Cloudflare Access (Workers & Pages → the Worker → Access → "Protect this
 * Worker behind Access"), which covers routes, custom domains, the workers.dev
 * hostname, and previews. Rolling a password system here would be strictly
 * worse than the identity layer already in front of it.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { rankCandidates, type DriverRow } from "../domain/dispatch";
import { DevOutboxTransport, CloudApiTransport } from "../adapters/whatsapp/transport";
import { isDevMode } from "../env";
import { createFlowContext } from "../domain/flow";
import { cancelTrip, getTrip } from "../domain/trips";
import { claimDriver } from "../domain/dispatch";
import { listZones } from "../domain/places";
import {
  createDriver,
  formatPhone,
  listDrivers,
  setDriverActive,
  updateDriver,
  type DriverInput,
} from "../domain/roster";

export const apiRoutes = new Hono<{ Bindings: Env }>();

function ctxFor(env: Env, now: number) {
  const transport = isDevMode(env)
    ? new DevOutboxTransport(env.DB, now)
    : new CloudApiTransport(
        env.WHATSAPP_PHONE_NUMBER_ID,
        env.WHATSAPP_TOKEN,
        env.WHATSAPP_API_VERSION,
      );
  return createFlowContext(env.DB, transport, now);
}

/** The live board: who is working, what is waiting. */
apiRoutes.get("/board", async (c) => {
  const now = Date.now();

  const drivers = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.tuktuk_no, d.status, d.available_at, d.idle_since,
            z.name AS zone_name, pz.name AS projected_zone_name,
            t.id AS trip_id, t.dest_label AS trip_dest
     FROM drivers d
     LEFT JOIN zones z   ON z.id  = d.zone_id
     LEFT JOIN zones pz  ON pz.id = d.projected_zone_id
     LEFT JOIN trips t   ON t.driver_id = d.id AND t.state IN ('assigned','on_trip')
     WHERE d.active = 1
     ORDER BY CASE d.status WHEN 'on_trip' THEN 0 WHEN 'assigned' THEN 1
                            WHEN 'available' THEN 2 WHEN 'break' THEN 3 ELSE 4 END, d.name`,
  ).all();

  const pending = await c.env.DB.prepare(
    `SELECT t.id, t.customer_phone, t.dest_label, t.requested_at, t.quoted_wait_min,
            z.name AS pickup_zone_name, t.pickup_zone_id
     FROM trips t
     LEFT JOIN zones z ON z.id = t.pickup_zone_id
     WHERE t.state = 'pending' ORDER BY t.requested_at`,
  ).all<{
    id: number;
    customer_phone: string | null;
    dest_label: string | null;
    requested_at: number;
    quoted_wait_min: number | null;
    pickup_zone_name: string | null;
    pickup_zone_id: string | null;
  }>();

  // Attach the dispatcher's suggestion to each waiting hail.
  const withSuggestions = [];
  for (const trip of pending.results) {
    const ranked = await rankCandidates(c.env.DB, trip.pickup_zone_id, now);
    withSuggestions.push({
      ...trip,
      waitingMin: Math.round((now - trip.requested_at) / 60000),
      suggestions: ranked.slice(0, 3).map((r) => ({
        driverId: r.driver.id,
        name: r.driver.name,
        status: r.driver.status,
        etaMin: Math.round(r.score),
      })),
    });
  }

  return c.json({ now, drivers: drivers.results, pending: withSuggestions });
});

/** Dispatcher override — assign a specific driver to a specific trip. */
apiRoutes.post("/assign", async (c) => {
  const { tripId, driverId } = await c.req.json<{ tripId: number; driverId: number }>();
  const now = Date.now();

  const claimed = await claimDriver(c.env.DB, driverId, tripId, now);
  if (!claimed) return c.json({ ok: false, reason: "driver_or_trip_unavailable" }, 409);

  const driver = await c.env.DB.prepare(
    `SELECT id, phone, name, tuktuk_no, status, zone_id, projected_zone_id,
            available_at, idle_since FROM drivers WHERE id = ?`,
  )
    .bind(driverId)
    .first<DriverRow>();

  if (driver) await ctxFor(c.env, now).notifyDriverOfTrip(driver, tripId);
  return c.json({ ok: true });
});

apiRoutes.post("/cancel", async (c) => {
  const { tripId } = await c.req.json<{ tripId: number }>();
  const now = Date.now();
  const trip = await getTrip(c.env.DB, tripId);
  if (!trip) return c.json({ ok: false }, 404);

  await cancelTrip(c.env.DB, tripId, "office", now);
  return c.json({ ok: true });
});

/**
 * Trip and break report for a date range. Returns rows the dashboard renders
 * and the CSV export serializes — one query, two presentations.
 */
apiRoutes.get("/report", async (c) => {
  const from = Number(c.req.query("from") ?? 0);
  const to = Number(c.req.query("to") ?? Date.now());

  const trips = await c.env.DB.prepare(
    `SELECT d.name AS driver, COUNT(*) AS trips,
            SUM(CASE WHEN t.source = 'bandera' THEN 1 ELSE 0 END) AS banderas,
            AVG(CASE WHEN t.done_at IS NOT NULL AND t.assigned_at IS NOT NULL
                     THEN (t.done_at - t.assigned_at) / 60000.0 END) AS avg_trip_min
     FROM trips t JOIN drivers d ON d.id = t.driver_id
     WHERE t.state = 'done' AND t.done_at BETWEEN ? AND ?
     GROUP BY d.id ORDER BY trips DESC`,
  )
    .bind(from, to)
    .all();

  const flows = await c.env.DB.prepare(
    `SELECT pz.name AS from_zone, dz.name AS to_zone, COUNT(*) AS trips
     FROM trips t
     LEFT JOIN zones pz ON pz.id = t.pickup_zone_id
     LEFT JOIN zones dz ON dz.id = t.dest_zone_id
     WHERE t.state = 'done' AND t.done_at BETWEEN ? AND ?
     GROUP BY t.pickup_zone_id, t.dest_zone_id ORDER BY trips DESC LIMIT 20`,
  )
    .bind(from, to)
    .all();

  const breaks = await c.env.DB.prepare(
    `SELECT d.name AS driver, COUNT(*) AS breaks
     FROM status_events s JOIN drivers d ON d.id = s.driver_id
     WHERE s.status = 'break' AND s.at BETWEEN ? AND ?
     GROUP BY d.id ORDER BY breaks DESC`,
  )
    .bind(from, to)
    .all();

  return c.json({ from, to, byDriver: trips.results, flows: flows.results, breaks: breaks.results });
});

apiRoutes.get("/report.csv", async (c) => {
  const from = Number(c.req.query("from") ?? 0);
  const to = Number(c.req.query("to") ?? Date.now());

  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.source, t.state, d.name AS driver, t.customer_phone,
            pz.name AS pickup_zone, t.dest_label,
            t.requested_at, t.assigned_at, t.done_at
     FROM trips t
     LEFT JOIN drivers d ON d.id = t.driver_id
     LEFT JOIN zones pz  ON pz.id = t.pickup_zone_id
     WHERE t.requested_at BETWEEN ? AND ? ORDER BY t.id`,
  )
    .bind(from, to)
    .all<Record<string, unknown>>();

  const headers = [
    "id", "source", "state", "driver", "customer_phone", "pickup_zone",
    "dest_label", "requested_at", "assigned_at", "done_at",
  ];
  const lines = [headers.join(",")];
  for (const row of results) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="viajes-${from}-${to}.csv"`,
    },
  });
});

/* ---------------- driver roster ---------------- */

/** Roster plus the zone list, so the form can be rendered from one request. */
apiRoutes.get("/drivers", async (c) => {
  const [drivers, zones] = await Promise.all([
    listDrivers(c.env.DB),
    listZones(c.env.DB),
  ]);
  return c.json({
    drivers: drivers.map((d) => ({ ...d, phone_display: formatPhone(d.phone) })),
    zones: zones.map((z) => ({ id: z.id, name: z.name })),
  });
});

apiRoutes.post("/drivers", async (c) => {
  const body = await c.req.json<DriverInput>();
  const result = await createDriver(c.env.DB, body, Date.now());
  return result.ok
    ? c.json({ ok: true, driver: result.value })
    : c.json({ ok: false, error: result.error }, 400);
});

apiRoutes.patch("/drivers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<DriverInput>();
  const result = await updateDriver(c.env.DB, id, body, Date.now());
  return result.ok
    ? c.json({ ok: true, driver: result.value })
    : c.json({ ok: false, error: result.error }, 400);
});

apiRoutes.post("/drivers/:id/active", async (c) => {
  const id = Number(c.req.param("id"));
  const { active } = await c.req.json<{ active: boolean }>();
  const result = await setDriverActive(c.env.DB, id, active, Date.now());
  return result.ok
    ? c.json({ ok: true, driver: result.value })
    : c.json({ ok: false, error: result.error }, 409);
});

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
