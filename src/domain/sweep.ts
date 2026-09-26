/**
 * The one-minute cron sweep.
 *
 * Real failure modes this catches: a driver who never taps Listo because their
 * phone died mid-trip, and a hail that nobody picked up because every driver
 * went on break at once. Both leave rows stranded in a non-terminal state, and
 * without a sweep the fleet quietly stops working with no error anywhere.
 */

import type { FlowContext } from "./flow";
import { assignTrip } from "./dispatch";
import { pendingTrips } from "./trips";
import { copy } from "./copy";
import { getZone } from "./places";

/** How long a hail may sit unassigned before the sweep retries it. */
const RETRY_PENDING_AFTER_MS = 2 * 60 * 1000;
/** How long a trip may stay open before we assume the driver forgot. */
const STALE_TRIP_AFTER_MS = 60 * 60 * 1000;

export async function sweepStuckState(ctx: FlowContext): Promise<void> {
  await retryPendingHails(ctx);
  await nudgeStaleTrips(ctx);
}

/**
 * Re-attempt assignment for hails that are still pending.
 *
 * A hail goes unassigned when every driver was busy at request time. Drivers
 * normally pick these up themselves on the next ✅ Listo, so this is the
 * backstop for the case where nobody taps anything for a while.
 */
async function retryPendingHails(ctx: FlowContext): Promise<void> {
  const queue = await pendingTrips(ctx.db);

  for (const trip of queue) {
    if (ctx.now - trip.requested_at < RETRY_PENDING_AFTER_MS) continue;

    const assignment = await assignTrip(ctx.db, trip.id, trip.pickup_zone_id, ctx.now);
    if (!assignment) continue;

    await ctx.notifyDriverOfTrip(assignment.driver, trip.id);

    if (trip.customer_phone) {
      await ctx.send(trip.customer_phone, {
        kind: "text",
        body: copy.customer.driverOnWay(assignment.driver.name, assignment.driver.tuktuk_no),
      });
    }
  }
}

/**
 * Prompt a driver whose trip has been open implausibly long.
 *
 * Deliberately a nudge and not an auto-close: guessing that a trip finished
 * would corrupt both the driver's inferred position and the travel-time matrix
 * that dispatch depends on.
 */
async function nudgeStaleTrips(ctx: FlowContext): Promise<void> {
  const { results } = await ctx.db
    .prepare(
      `SELECT t.id, t.driver_id, t.dest_label, t.dest_zone_id, d.phone
       FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE t.state IN ('assigned','on_trip')
         AND COALESCE(t.assigned_at, t.requested_at) < ?`,
    )
    .bind(ctx.now - STALE_TRIP_AFTER_MS)
    .all<{
      id: number;
      driver_id: number;
      dest_label: string | null;
      dest_zone_id: string | null;
      phone: string;
    }>();

  for (const row of results) {
    // Nudge once per sweep interval at most — the marker is a status_event, so
    // a driver mid-siesta is not pestered every minute for an hour.
    const recent = await ctx.db
      .prepare(
        `SELECT 1 FROM status_events
         WHERE driver_id = ? AND status = 'nudged' AND at > ?`,
      )
      .bind(row.driver_id, ctx.now - STALE_TRIP_AFTER_MS)
      .first();
    if (recent) continue;

    const dest = row.dest_label ?? (await zoneLabel(ctx, row.dest_zone_id));
    await ctx.send(row.phone, {
      kind: "buttons",
      body: `¿Ya terminó el viaje a *${dest}*?`,
      buttons: [
        { id: "drv:done", title: copy.driver.buttons.done },
        { id: "drv:break", title: copy.driver.buttons.break },
      ],
    });

    await ctx.db
      .prepare("INSERT INTO status_events (driver_id, status, zone_id, at) VALUES (?, 'nudged', NULL, ?)")
      .bind(row.driver_id, ctx.now)
      .run();
  }
}

async function zoneLabel(ctx: FlowContext, zoneId: string | null): Promise<string> {
  if (!zoneId) return "—";
  const zone = await getZone(ctx.db, zoneId);
  return zone?.name ?? "—";
}
