/**
 * Driver selection and assignment.
 *
 * The scoring rule is deliberately one line of arithmetic. We are not solving
 * the travelling salesman problem; we are replacing "no system at all", and any
 * model more precise than zone-level would be lying about roads that get
 * blocked by an unloading truck for twenty minutes.
 */

import { travelMinutes } from "./places";

export type DriverRow = {
  id: number;
  phone: string;
  name: string;
  tuktuk_no: string | null;
  status: string;
  zone_id: string | null;
  projected_zone_id: string | null;
  available_at: number;
  idle_since: number;
};

export type Candidate = {
  driver: DriverRow;
  /** Minutes until they finish what they are doing. */
  waitMin: number;
  /** Minutes from where they will be to the pickup. */
  approachMin: number;
  /** waitMin + approachMin — lower is better. */
  score: number;
};

/**
 * Drivers eligible to be offered a trip.
 *
 * Includes `assigned`/`on_trip` drivers because a driver about to drop off at
 * Las Ruinas is the right answer for a customer waiting at Las Ruinas — chaining
 * a drop-off into a nearby pickup is where most of the routing win lives.
 * Drivers on `break` and `off` are excluded entirely.
 */
export async function rankCandidates(
  db: D1Database,
  pickupZone: string | null,
  now: number,
  opts: { includeBusy?: boolean } = {},
): Promise<Candidate[]> {
  const includeBusy = opts.includeBusy ?? true;
  const statuses = includeBusy
    ? ["available", "assigned", "on_trip"]
    : ["available"];

  const placeholders = statuses.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT id, phone, name, tuktuk_no, status, zone_id, projected_zone_id,
              available_at, idle_since
       FROM drivers
       WHERE active = 1 AND status IN (${placeholders})`,
    )
    .bind(...statuses)
    .all<DriverRow>();

  const candidates: Candidate[] = [];
  for (const driver of results) {
    const waitMin = Math.max(0, (driver.available_at - now) / 60000);
    const fromZone = driver.projected_zone_id ?? driver.zone_id;
    const approachMin = await travelMinutes(db, fromZone, pickupZone);
    candidates.push({ driver, waitMin, approachMin, score: waitMin + approachMin });
  }

  // Fairness tie-break: when two drivers score within a minute of each other,
  // prefer whoever has been idle longest. Without this the same driver near the
  // park takes every trip and the others earn nothing.
  candidates.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1) return a.score - b.score;
    return a.driver.idle_since - b.driver.idle_since;
  });

  return candidates;
}

/**
 * Claim a driver for a trip without locks.
 *
 * D1 has no interactive transactions, so the guard is a conditional UPDATE:
 * only a row still in the expected status changes, and `meta.changes === 0`
 * means someone else won the race and we should try the next candidate.
 */
export async function claimDriver(
  db: D1Database,
  driverId: number,
  tripId: number,
  now: number,
): Promise<boolean> {
  const claim = await db
    .prepare(
      `UPDATE drivers
       SET status = 'assigned', updated_at = ?
       WHERE id = ? AND status = 'available' AND active = 1`,
    )
    .bind(now, driverId)
    .run();

  if (claim.meta.changes === 0) return false;

  const trip = await db
    .prepare(
      `UPDATE trips
       SET driver_id = ?, state = 'assigned', assigned_at = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .bind(driverId, now, tripId)
    .run();

  if (trip.meta.changes === 0) {
    // The trip was taken or canceled between our two statements. Release the
    // driver so they are not stranded in `assigned` with nothing to do.
    await db
      .prepare("UPDATE drivers SET status = 'available', updated_at = ? WHERE id = ?")
      .bind(now, driverId)
      .run();
    return false;
  }

  return true;
}

/**
 * Queue a trip to the best driver who will actually accept it now.
 *
 * Only `available` drivers can be claimed — a busy driver is ranked so the
 * office can see who is closest, but the trip stays pending until they tap
 * Listo, at which point the driver flow picks it up.
 */
export async function assignTrip(
  db: D1Database,
  tripId: number,
  pickupZone: string | null,
  now: number,
): Promise<{ driver: DriverRow; etaMin: number } | null> {
  const candidates = await rankCandidates(db, pickupZone, now);

  for (const c of candidates) {
    if (c.driver.status !== "available") continue;
    if (await claimDriver(db, c.driver.id, tripId, now)) {
      return { driver: c.driver, etaMin: c.score };
    }
  }
  return null;
}

/** Best-case wait to quote a customer, including drivers still finishing a trip. */
export async function quoteWaitMinutes(
  db: D1Database,
  pickupZone: string | null,
  now: number,
): Promise<number | null> {
  const candidates = await rankCandidates(db, pickupZone, now);
  const best = candidates[0];
  return best ? Math.round(best.score) : null;
}
