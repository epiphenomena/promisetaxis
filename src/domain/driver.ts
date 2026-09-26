/**
 * Driver conversation: three buttons, and keyword aliases for when buttons fail.
 *
 * The state machine here doubles as the position-tracking system. Tapping
 * ✅ Listo says "I am at the destination of the trip I just closed", which is
 * why no GPS pings or background tasks are needed anywhere in this design.
 */

import type { FlowContext } from "./flow";
import type { InboundEvent, OutboundSpec } from "./types";
import { copy, driverKeywords } from "./copy";
import { getZone, listZones, normalize, zoneForPoint } from "./places";
import { assignTrip } from "./dispatch";
import type { DriverRow } from "./dispatch";
import {
  activeTripForDriver,
  completeTrip,
  createBandera,
  getTrip,
  pendingTrips,
  markDriverUnderway,
} from "./trips";
import type { Session } from "./sessions";
import { fitRowTitle, WA_MAX_LIST_ROWS } from "./types";

export async function handleDriver(
  ctx: FlowContext,
  session: Session,
  event: InboundEvent,
  registered: DriverRow,
): Promise<Session> {
  // Registration deliberately leaves a driver 'off', on the promise that their
  // first message is what joins them to dispatch — see createDriver. This is that
  // half. Without it sendStatus tells an 'off' driver "Está disponible" while
  // rankCandidates skips them for being off, so a driver the office just added can
  // never be sent a trip and nothing in the conversation says why.
  const shiftStarted = registered.status === "off";
  const driver = shiftStarted ? await beginShift(ctx, session, event, registered) : registered;

  const action = resolveAction(event);

  if (event.payload.kind === "location") {
    return onLocation(ctx, session, driver, event.payload.lat, event.payload.lng);
  }

  // Bandera destination selection interrupts the normal button loop.
  if (session.state === "awaiting_bandera_dest") {
    if (event.payload.kind === "list" && event.payload.id.startsWith("bzone:")) {
      return onBanderaDest(ctx, session, driver, event.payload.id.slice("bzone:".length));
    }
    return sendBanderaZoneMenu(ctx, session);
  }

  switch (action) {
    case "done":
      return onDone(ctx, session, driver);
    case "bandera":
      return onBandera(ctx, session, driver);
    case "break":
      return onBreak(ctx, session, driver);
    case "resume":
      return onResume(ctx, session, driver);
    case "help":
      await ctx.send(session.phone, { kind: "text", body: copy.driver.help });
      return session;
    default:
      // Somebody who has just come on shift and typed something we do not
      // recognise is reporting for work, not asking for a status line. Offer them
      // the queue the way onResume does — otherwise a trip that went unassigned
      // while the fleet was off sits pending until the cron sweep retries it.
      return shiftStarted
        ? offerNextTrip(ctx, session, driver)
        : sendStatus(ctx, session, driver);
  }
}

/**
 * First contact from a registered driver starts their shift.
 *
 * Only the status changes here; the message they actually sent is still handled
 * by the caller, because a driver whose first word of the day is "descanso" must
 * end up on break rather than have the word swallowed by the shift start.
 */
async function beginShift(
  ctx: FlowContext,
  session: Session,
  event: InboundEvent,
  driver: DriverRow,
): Promise<DriverRow> {
  await ctx.db
    .prepare(
      `UPDATE drivers SET status = 'available', available_at = ?, idle_since = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(ctx.now, ctx.now, ctx.now, driver.id)
    .run();

  // The office's break reporting reads status_events, so the start of a working
  // day belongs in it. Logged as 'available', the same token onResume writes,
  // which is what a later 'break' row pairs against.
  await logStatus(ctx, driver, "available");

  // A home zone is optional on the roster, and an unknown position is scored with
  // travelMinutes' pessimistic 10-minute fallback from every corner of town. One
  // message fixes that — but not when the message in hand is already a pin, which
  // onLocation is about to save anyway.
  if (!driver.zone_id && event.payload.kind !== "location") {
    await ctx.send(session.phone, { kind: "text", body: copy.driver.askLocation });
  }

  return { ...driver, status: "available", available_at: ctx.now, idle_since: ctx.now };
}

/** Buttons and typed keywords collapse to the same four actions. */
function resolveAction(event: InboundEvent): string | null {
  const p = event.payload;
  if (p.kind === "button" && p.id.startsWith("drv:")) return p.id.slice("drv:".length);
  if (p.kind === "text") return driverKeywords[normalize(p.text)] ?? null;
  return null;
}

/**
 * ✅ Listo — close the current trip, then immediately offer the next one.
 *
 * This is the chaining moment: the driver's newly-known position is the
 * destination they just reached, so the next pickup is scored from there.
 */
async function onDone(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  const trip = await activeTripForDriver(ctx.db, driver.id);

  if (!trip) {
    await ctx.send(session.phone, { kind: "text", body: copy.driver.noActiveTrip });
    return sendStatus(ctx, session, driver);
  }

  await completeTrip(ctx.db, trip, ctx.now);
  await ctx.send(session.phone, { kind: "text", body: copy.driver.tripDone });

  if (trip.customer_phone) {
    await ctx.send(trip.customer_phone, { kind: "text", body: copy.customer.tripDone });
    await ctx.closeCustomerSession(trip.customer_phone);
  }

  return offerNextTrip(ctx, session, driver);
}

/**
 * Pull the oldest pending trip this driver can serve and hand it over.
 * Falls back to the idle prompt when the queue is empty.
 */
async function offerNextTrip(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  const queue = await pendingTrips(ctx.db);

  for (const trip of queue) {
    const assignment = await assignTrip(ctx.db, trip.id, trip.pickup_zone_id, ctx.now);
    if (!assignment) continue;

    // The hand-off is identical whether the trip lands on this driver or on
    // another who scored better; only the return value differs. Routing both
    // through notifyDriverOfTrip is what keeps the customer notified and the
    // projection updated in either case.
    await ctx.notifyDriverOfTrip(assignment.driver, trip.id);

    const fresh = await getTrip(ctx.db, trip.id);
    if (fresh?.customer_phone) {
      await ctx.send(fresh.customer_phone, {
        kind: "text",
        body: copy.customer.driverOnWay(assignment.driver.name, assignment.driver.tuktuk_no),
      });
    }

    if (assignment.driver.id === driver.id) return { ...session, state: "on_trip" };
  }

  await sendButtons(ctx, session.phone, copy.driver.idle);
  return { ...session, state: "available" };
}

/** ✋ Bandera — a passenger flagged the driver down; log where they are headed. */
async function onBandera(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  const existing = await activeTripForDriver(ctx.db, driver.id);
  if (existing) await completeTrip(ctx.db, existing, ctx.now);

  const tripId = await createBandera(ctx.db, {
    driverId: driver.id,
    pickupZone: driver.zone_id,
    now: ctx.now,
  });

  const next: Session = {
    ...session,
    state: "awaiting_bandera_dest",
    context: { ...session.context, banderaTripId: tripId },
  };
  return sendBanderaZoneMenu(ctx, next);
}

async function sendBanderaZoneMenu(ctx: FlowContext, session: Session): Promise<Session> {
  const zones = await listZones(ctx.db);
  await ctx.send(session.phone, {
    kind: "list",
    body: copy.driver.askBanderaDest,
    buttonLabel: copy.driver.banderaZoneButton,
    sections: [
      {
        rows: zones
          .slice(0, WA_MAX_LIST_ROWS)
          .map((z) => ({ id: `bzone:${z.id}`, title: fitRowTitle(z.name) })),
      },
    ],
  });
  return { ...session, state: "awaiting_bandera_dest" };
}

async function onBanderaDest(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
  zoneId: string,
): Promise<Session> {
  const tripId = session.context.banderaTripId;
  const zone = await getZone(ctx.db, zoneId);
  if (!tripId || !zone) return sendStatus(ctx, session, driver);

  await ctx.db
    .prepare("UPDATE trips SET dest_zone_id = ?, dest_label = ? WHERE id = ?")
    .bind(zoneId, zone.name, tripId)
    .run();

  const trip = await getTrip(ctx.db, tripId);
  if (trip) await markDriverUnderway(ctx.db, trip, ctx.now, { status: "on_trip" });

  await sendButtons(ctx, session.phone, copy.driver.banderaLogged(zone.name));

  return {
    ...session,
    state: "on_trip",
    context: { ...session.context, banderaTripId: undefined },
  };
}

async function onBreak(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  // Refuse while a trip is open. An orphaned trip is worse than it looks:
  // activeTripForDriver returns the oldest one, so the driver's next ✅ Listo
  // would close the stale trip and inherit its destination as their position,
  // and every later trip compounds the error instead of healing it.
  const open = await activeTripForDriver(ctx.db, driver.id);
  if (open) {
    await ctx.send(session.phone, { kind: "text", body: copy.driver.finishTripFirst });
    return sendStatus(ctx, session, driver);
  }

  // Exclusion from dispatch comes from the status alone — rankCandidates never
  // looks at drivers on break. Parking a far-future sentinel in available_at
  // would just be a landmine: any path that restores the status without also
  // clearing it yields a wait quote of several thousand years.
  await ctx.db
    .prepare(
      "UPDATE drivers SET status = 'break', available_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(ctx.now, ctx.now, driver.id)
    .run();
  await logStatus(ctx, driver, "break");

  await ctx.send(session.phone, {
    kind: "buttons",
    body: copy.driver.onBreak,
    buttons: [{ id: "drv:resume", title: copy.driver.buttons.resume }],
  });
  return { ...session, state: "break" };
}

async function onResume(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  await ctx.db
    .prepare(
      `UPDATE drivers SET status = 'available', available_at = ?, idle_since = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(ctx.now, ctx.now, ctx.now, driver.id)
    .run();
  await logStatus(ctx, driver, "available");

  await ctx.send(session.phone, { kind: "text", body: copy.driver.backAvailable });
  const refreshed = { ...driver, status: "available", available_at: ctx.now };
  return offerNextTrip(ctx, session, refreshed);
}

/** Cold-start position fix — start of shift, or returning from a break elsewhere. */
async function onLocation(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
  lat: number,
  lng: number,
): Promise<Session> {
  const zone = await zoneForPoint(ctx.db, { lat, lng });
  if (!zone) return session;

  await ctx.db
    .prepare(
      "UPDATE drivers SET zone_id = ?, projected_zone_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(zone.id, zone.id, ctx.now, driver.id)
    .run();

  await ctx.send(session.phone, {
    kind: "text",
    body: copy.driver.locationSaved(zone.name),
  });
  return sendStatus(ctx, session, { ...driver, zone_id: zone.id });
}

/** Re-show the current trip, or the idle prompt, with the buttons attached. */
async function sendStatus(
  ctx: FlowContext,
  session: Session,
  driver: DriverRow,
): Promise<Session> {
  const trip = await activeTripForDriver(ctx.db, driver.id);

  if (trip) {
    await sendTripToDriver(ctx, session.phone, trip);
    return { ...session, state: "on_trip" };
  }

  if (driver.status === "break") {
    await ctx.send(session.phone, {
      kind: "buttons",
      body: copy.driver.onBreak,
      buttons: [{ id: "drv:resume", title: copy.driver.buttons.resume }],
    });
    return { ...session, state: "break" };
  }

  await sendButtons(ctx, session.phone, copy.driver.idle);
  return { ...session, state: "available" };
}

/** A trip hand-off is two messages: the details, then the customer's exact pin. */
async function sendTripToDriver(
  ctx: FlowContext,
  phone: string,
  trip: { pickup_label: string | null; pickup_zone_id: string | null; dest_label: string | null;
          pickup_lat: number | null; pickup_lng: number | null },
): Promise<void> {
  const pickup = trip.pickup_label ?? (await zoneName(ctx, trip.pickup_zone_id));
  const dest = trip.dest_label ?? "—";

  await sendButtons(ctx, phone, copy.driver.newTrip(pickup, dest));

  if (trip.pickup_lat !== null && trip.pickup_lng !== null) {
    await ctx.send(phone, {
      kind: "location",
      lat: trip.pickup_lat,
      lng: trip.pickup_lng,
      name: copy.driver.pinCaption,
    });
  }
}

/**
 * The driver's entire interface. WhatsApp allows exactly three reply buttons,
 * which happens to be exactly what this job needs.
 */
async function sendButtons(ctx: FlowContext, phone: string, body: string): Promise<void> {
  const spec: OutboundSpec = {
    kind: "buttons",
    body,
    buttons: [
      { id: "drv:done", title: copy.driver.buttons.done },
      { id: "drv:bandera", title: copy.driver.buttons.bandera },
      { id: "drv:break", title: copy.driver.buttons.break },
    ],
  };
  await ctx.send(phone, spec);
}

async function zoneName(ctx: FlowContext, zoneId: string | null): Promise<string> {
  if (!zoneId) return "—";
  const zone = await getZone(ctx.db, zoneId);
  return zone?.name ?? "—";
}

async function logStatus(ctx: FlowContext, driver: DriverRow, status: string): Promise<void> {
  await ctx.db
    .prepare("INSERT INTO status_events (driver_id, status, zone_id, at) VALUES (?, ?, ?, ?)")
    .bind(driver.id, status, driver.zone_id, ctx.now)
    .run();
}
