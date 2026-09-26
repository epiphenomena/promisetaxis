/** Trip lifecycle and the driver-position inference that rides on it. */

import { travelMinutes } from "./places";

export type TripRow = {
  id: number;
  source: string;
  customer_phone: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_zone_id: string | null;
  pickup_label: string | null;
  dest_zone_id: string | null;
  dest_landmark_id: string | null;
  dest_label: string | null;
  driver_id: number | null;
  state: string;
  quoted_wait_min: number | null;
  /** Minutes the driver spent reaching the pickup. Null when never marked under way. */
  approach_min: number | null;
  requested_at: number;
  assigned_at: number | null;
  done_at: number | null;
};

const TRIP_COLS = `id, source, customer_phone, pickup_lat, pickup_lng, pickup_zone_id,
  pickup_label, dest_zone_id, dest_landmark_id, dest_label, driver_id, state,
  quoted_wait_min, approach_min, requested_at, assigned_at, done_at`;

export async function createHail(
  db: D1Database,
  input: {
    customerPhone: string;
    pickupLat: number | null;
    pickupLng: number | null;
    pickupZone: string | null;
    pickupLabel: string | null;
    destZone: string | null;
    destLandmark: string | null;
    destLabel: string | null;
    now: number;
  },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO trips (source, customer_phone, pickup_lat, pickup_lng, pickup_zone_id,
                          pickup_label, dest_zone_id, dest_landmark_id, dest_label,
                          state, requested_at)
       VALUES ('hail', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      input.customerPhone,
      input.pickupLat,
      input.pickupLng,
      input.pickupZone,
      input.pickupLabel,
      input.destZone,
      input.destLandmark,
      input.destLabel,
      input.now,
    )
    .run();
  return res.meta.last_row_id;
}

/** A passenger flagged down in the street — no customer phone, already aboard. */
export async function createBandera(
  db: D1Database,
  input: { driverId: number; pickupZone: string | null; now: number },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO trips (source, pickup_zone_id, driver_id, state, requested_at,
                          assigned_at, picked_up_at)
       VALUES ('bandera', ?, ?, 'on_trip', ?, ?, ?)`,
    )
    .bind(input.pickupZone, input.driverId, input.now, input.now, input.now)
    .run();
  return res.meta.last_row_id;
}

export async function getTrip(db: D1Database, id: number): Promise<TripRow | null> {
  return db.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE id = ?`).bind(id).first<TripRow>();
}

export async function activeTripForDriver(
  db: D1Database,
  driverId: number,
): Promise<TripRow | null> {
  return db
    .prepare(
      `SELECT ${TRIP_COLS} FROM trips
       WHERE driver_id = ? AND state IN ('assigned','on_trip')
       ORDER BY requested_at LIMIT 1`,
    )
    .bind(driverId)
    .first<TripRow>();
}

export async function pendingTrips(db: D1Database): Promise<TripRow[]> {
  const { results } = await db
    .prepare(`SELECT ${TRIP_COLS} FROM trips WHERE state = 'pending' ORDER BY requested_at`)
    .all<TripRow>();
  return results;
}

export async function activeTripForCustomer(
  db: D1Database,
  phone: string,
): Promise<TripRow | null> {
  return db
    .prepare(
      `SELECT ${TRIP_COLS} FROM trips
       WHERE customer_phone = ? AND state IN ('pending','assigned','on_trip')
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .bind(phone)
    .first<TripRow>();
}

export async function cancelTrip(
  db: D1Database,
  tripId: number,
  reason: string,
  now: number,
): Promise<void> {
  const trip = await getTrip(db, tripId);
  if (!trip) return;

  const canceled = await db
    .prepare(
      `UPDATE trips SET state = 'canceled', canceled_reason = ?, done_at = ?
       WHERE id = ? AND state IN ('pending','assigned')`,
    )
    .bind(reason, now, tripId)
    .run();

  if (canceled.meta.changes === 0) return;

  // Free the driver and undo the projection — they are no longer heading
  // anywhere, so leaving projected_zone_id set would score them against a
  // destination they will never reach.
  if (trip.driver_id) {
    await db
      .prepare(
        `UPDATE drivers
         SET status = 'available', projected_zone_id = zone_id,
             available_at = ?, idle_since = ?, updated_at = ?
         WHERE id = ? AND status IN ('assigned','on_trip')`,
      )
      .bind(now, now, now, trip.driver_id)
      .run();
  }
}

/**
 * Close a trip and update the driver's inferred position.
 *
 * This is the whole tracking system: a driver who just finished a trip is, by
 * definition, at that trip's destination. No GPS pings, no background tasks.
 */
export async function completeTrip(
  db: D1Database,
  trip: TripRow,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE trips SET state = 'done', done_at = ? WHERE id = ?")
    .bind(now, trip.id)
    .run();

  if (trip.driver_id) {
    const landedZone = trip.dest_zone_id ?? trip.pickup_zone_id;
    await db
      .prepare(
        `UPDATE drivers
         SET status = 'available', zone_id = ?, projected_zone_id = ?,
             available_at = ?, idle_since = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(landedZone, landedZone, now, now, now, trip.driver_id)
      .run();
  }

  await learnZoneTime(db, trip, now);
}

/**
 * Mark a driver as under way and project where they will end up, so the next
 * hail can be scored against their destination rather than their current spot.
 */
export async function markDriverUnderway(
  db: D1Database,
  trip: TripRow,
  now: number,
  opts: { status?: "assigned" | "on_trip" } = {},
): Promise<void> {
  if (!trip.driver_id) return;

  const driver = await db
    .prepare("SELECT zone_id FROM drivers WHERE id = ?")
    .bind(trip.driver_id)
    .first<{ zone_id: string | null }>();

  // Both legs count: the driver still has to reach the pickup before the trip
  // itself starts. Omitting the approach makes every quoted wait optimistic by
  // 3–10 minutes on a town-sized matrix.
  //
  // Except for a bandera, where the passenger is already aboard. Its pickup zone
  // *is* the driver's own zone, so travelMinutes would hand back the same-zone
  // value (~3 min) for a drive that never happens — pushing available_at out and
  // making the driver look busier than they are on every flagged-down fare.
  const approachMin =
    trip.source === "bandera"
      ? 0
      : await travelMinutes(db, driver?.zone_id ?? null, trip.pickup_zone_id);
  const legMin = await travelMinutes(db, trip.pickup_zone_id, trip.dest_zone_id);

  // Stored rather than recomputed when the trip closes: by then completeTrip has
  // overwritten the driver's zone_id with the destination they reached, so where
  // they started the approach from is gone and learnZoneTime could not subtract it.
  await db
    .prepare("UPDATE trips SET approach_min = ? WHERE id = ?")
    .bind(approachMin, trip.id)
    .run();

  // Deliberately does not touch trips.state. A hail stays 'assigned' until it
  // is done, because the driver interface has no "picked up" button — inventing
  // an on_trip transition here would put the trip past the point cancelTrip
  // accepts, and a customer who changed their mind could no longer cancel.
  await db
    .prepare(
      `UPDATE drivers
       SET status = COALESCE(?, status), projected_zone_id = ?, available_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      opts.status ?? null,
      trip.dest_zone_id,
      now + (approachMin + legMin) * 60000,
      now,
      trip.driver_id,
    )
    .run();
}

/**
 * Fold an observed duration into the travel-time matrix with a running average.
 *
 * Hand-seeded rows carry samples = 0, which the schema documents as "seeded by
 * hand" and not as "worthless": they are blended as though they were a single
 * observation, so the first real trip refines the surveyed guess instead of
 * erasing it. Weight is capped so the estimate keeps adapting to seasonal
 * changes — the road to the ruins is slower in the rain.
 */
async function learnZoneTime(db: D1Database, trip: TripRow, doneAt: number): Promise<void> {
  // `doneAt` is passed in rather than read off `trip`: the caller holds the row
  // as it looked *before* the completing UPDATE, so trip.done_at is still null.
  if (!trip.assigned_at) return;
  if (!trip.pickup_zone_id || !trip.dest_zone_id) return;

  // The cell being taught is pickup→dest, so the only honest input is the carry
  // leg. The span since assignment also contains the drive to the passenger, and
  // travelMinutes reads this same cell back when it estimates an approach — leave
  // the approach in and it is fed into the number used to predict itself, which
  // drifted cells by ×1.22 to ×2.28 over one simulated day. Subtracted before the
  // guard below, so a real 12-minute span behind a 10-minute approach is not
  // thrown away for looking too short.
  const observedMin = (doneAt - trip.assigned_at) / 60000 - (trip.approach_min ?? 0);
  // Guard against a driver who forgot to tap Listo until the next morning.
  if (observedMin <= 0 || observedMin > 90) return;

  const row = await db
    .prepare("SELECT minutes, samples FROM zone_times WHERE from_zone = ? AND to_zone = ?")
    .bind(trip.pickup_zone_id, trip.dest_zone_id)
    .first<{ minutes: number; samples: number }>();

  if (!row) {
    await db
      .prepare(
        `INSERT INTO zone_times (from_zone, to_zone, minutes, samples) VALUES (?, ?, ?, 1)`,
      )
      .bind(trip.pickup_zone_id, trip.dest_zone_id, observedMin)
      .run();
    return;
  }

  // Floored at 1 so a hand-seeded row (samples = 0) is not simply overwritten by
  // whatever the first trip happened to take — one slow fare behind a truck would
  // otherwise become the town's official travel time until enough trips diluted it.
  const weight = Math.max(1, Math.min(row.samples, 20));
  const blended = (row.minutes * weight + observedMin) / (weight + 1);
  await db
    .prepare(
      `UPDATE zone_times SET minutes = ?, samples = ? WHERE from_zone = ? AND to_zone = ?`,
    )
    .bind(blended, row.samples + 1, trip.pickup_zone_id, trip.dest_zone_id)
    .run();
}
