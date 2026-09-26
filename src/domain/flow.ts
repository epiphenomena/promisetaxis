/**
 * The seam between the domain and the outside world.
 *
 * A FlowContext carries the database, the clock, and a way to send messages —
 * nothing else. Tests build one over local D1 with an in-memory transport; the
 * Worker builds one over the real D1 and either the Cloud API client or the
 * dev outbox. The state machines cannot tell the difference.
 */

import type { InboundEvent, OutboundMessage, OutboundSpec, Transport } from "./types";
import type { DriverRow } from "./dispatch";
import { handleCustomer } from "./customer";
import { handleDriver } from "./driver";
import { loadSession, saveSession, touchWindow } from "./sessions";
import { getTrip, markDriverUnderway } from "./trips";
import { copy } from "./copy";
import { getZone } from "./places";

export type FlowContext = {
  db: D1Database;
  now: number;
  send(to: string, spec: OutboundSpec): Promise<void>;
  /** Hand a freshly assigned trip to its driver, from inside the customer flow. */
  notifyDriverOfTrip(driver: DriverRow, tripId: number): Promise<void>;
  /** Return a customer to idle once their ride is over. */
  closeCustomerSession(phone: string): Promise<void>;
};

export function createFlowContext(
  db: D1Database,
  transport: Transport,
  now: number,
): FlowContext {
  const send = async (to: string, spec: OutboundSpec) => {
    const message: OutboundMessage = { to, spec };
    await transport.send(message);
    await db
      .prepare(
        `INSERT INTO events (direction, phone, kind, payload_json, message_id, at)
         VALUES ('out', ?, ?, ?, NULL, ?)`,
      )
      .bind(to, spec.kind, JSON.stringify(spec), now)
      .run();
  };

  const ctx: FlowContext = {
    db,
    now,
    send,

    async notifyDriverOfTrip(driver, tripId) {
      const trip = await getTrip(db, tripId);
      if (!trip) return;

      const pickupZone = trip.pickup_zone_id ? await getZone(db, trip.pickup_zone_id) : null;
      const pickup = trip.pickup_label ?? pickupZone?.name ?? "—";

      await send(driver.phone, {
        kind: "buttons",
        body: copy.driver.newTrip(pickup, trip.dest_label ?? "—"),
        buttons: [
          { id: "drv:done", title: copy.driver.buttons.done },
          { id: "drv:bandera", title: copy.driver.buttons.bandera },
          { id: "drv:break", title: copy.driver.buttons.break },
        ],
      });

      if (trip.pickup_lat !== null && trip.pickup_lng !== null) {
        await send(driver.phone, {
          kind: "location",
          lat: trip.pickup_lat,
          lng: trip.pickup_lng,
          name: copy.driver.pinCaption,
        });
      }

      // Mark the driver under way. Without this the fleet still shows them
      // parked where they started and free right now, so the next hail is
      // scored against the wrong place — the projection that makes chaining
      // work only exists once a trip is actually started.
      await markDriverUnderway(db, trip, now);

      const session = await loadSession(db, driver.phone, "driver");
      await saveSession(db, { ...session, role: "driver", state: "on_trip" }, now);
    },

    async closeCustomerSession(phone) {
      const session = await loadSession(db, phone, "customer");
      await saveSession(db, { ...session, state: "idle", context: {} }, now);
    },
  };

  return ctx;
}

/**
 * Route one inbound event to the right state machine.
 *
 * A phone number registered in `drivers` is always treated as a driver; every
 * other number is a customer. That keeps role detection out of the conversation
 * entirely — nobody has to say which one they are.
 */
export async function handleInbound(ctx: FlowContext, event: InboundEvent): Promise<void> {
  // Meta retries webhook deliveries, so the audit-log insert doubles as the
  // dedup gate: losing it means we already processed this message.
  const logged = await ctx.db
    .prepare(
      `INSERT OR IGNORE INTO events (direction, phone, kind, payload_json, message_id, at)
       VALUES ('in', ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.from,
      event.payload.kind,
      JSON.stringify(event.payload),
      event.messageId,
      event.at,
    )
    .run();

  if (logged.meta.changes === 0) return;

  const driver = await ctx.db
    .prepare(
      `SELECT id, phone, name, tuktuk_no, status, zone_id, projected_zone_id,
              available_at, idle_since
       FROM drivers WHERE phone = ? AND active = 1`,
    )
    .bind(event.from)
    .first<DriverRow>();

  const role = driver ? "driver" : "customer";
  const loaded = await loadSession(ctx.db, event.from, role);
  const session = touchWindow({ ...loaded, role }, ctx.now);

  const next = driver
    ? await handleDriver(ctx, session, event, driver)
    : await handleCustomer(ctx, session, event);

  await saveSession(ctx.db, next, ctx.now);
}
