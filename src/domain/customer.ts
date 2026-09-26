/**
 * Customer conversation: text → location → zone → landmark → quote.
 *
 * Two taps and no typing in the common path. Everything here is pure logic over
 * D1 plus `ctx.send` — no WhatsApp shapes, so it is fully testable offline.
 */

import type { FlowContext } from "./flow";
import type { InboundEvent } from "./types";
import { copy } from "./copy";
import {
  getLandmark,
  getZone,
  listLandmarks,
  listZones,
  matchLandmarkText,
  normalize,
  zoneForPoint,
} from "./places";
import { assignTrip, quoteWaitMinutes } from "./dispatch";
import { activeTripForCustomer, cancelTrip, createHail, getTrip } from "./trips";
import type { Session } from "./sessions";
import { fitRowTitle, WA_MAX_LIST_ROWS } from "./types";

export const OTHER_PLACE = "__other__";

export async function handleCustomer(
  ctx: FlowContext,
  session: Session,
  event: InboundEvent,
): Promise<Session> {
  const { payload } = event;

  // Global escapes, valid from any state.
  if (payload.kind === "text") {
    const word = normalize(payload.text);
    if (word === "cancelar" || word === "cancel") return cancel(ctx, session);
    if (word === "ayuda" || word === "help") {
      await ctx.send(session.phone, { kind: "text", body: copy.customer.help });
      return session;
    }
    if (word === "menu" || word === "menú") return startHail(ctx, session);
  }

  switch (session.state) {
    case "awaiting_location":
      if (payload.kind === "location") {
        return onLocation(ctx, session, payload.lat, payload.lng);
      }
      await ctx.send(session.phone, {
        kind: "locationRequest",
        body: copy.customer.locationRequest,
      });
      return session;

    case "awaiting_zone":
      if (payload.kind === "list" && payload.id.startsWith("zone:")) {
        return onZone(ctx, session, payload.id.slice("zone:".length));
      }
      if (payload.kind === "text") return onFreeText(ctx, session, payload.text);
      return sendZoneMenu(ctx, session);

    case "awaiting_landmark":
      if (payload.kind === "list" && payload.id.startsWith("lm:")) {
        const id = payload.id.slice("lm:".length);
        if (id === OTHER_PLACE) {
          await ctx.send(session.phone, {
            kind: "text",
            body: copy.customer.otherPlacePrompt,
          });
          return { ...session, state: "awaiting_text_confirm" };
        }
        return onLandmark(ctx, session, id);
      }
      if (payload.kind === "text") return onFreeText(ctx, session, payload.text);
      return sendLandmarkMenu(ctx, session, session.context.destZone ?? "");

    case "awaiting_text_confirm":
      if (payload.kind === "list" && payload.id.startsWith("lm:")) {
        return onLandmark(ctx, session, payload.id.slice("lm:".length));
      }
      if (payload.kind === "text") return onFreeText(ctx, session, payload.text);
      return session;

    case "waiting":
    case "riding":
      await ctx.send(session.phone, { kind: "text", body: copy.customer.alreadyWaiting });
      return session;

    default:
      return startHail(ctx, session);
  }
}

/** Any message from an idle customer opens the hail. */
async function startHail(ctx: FlowContext, session: Session): Promise<Session> {
  const existing = await activeTripForCustomer(ctx.db, session.phone);
  if (existing) {
    await ctx.send(session.phone, { kind: "text", body: copy.customer.alreadyWaiting });
    return { ...session, state: "waiting", context: { ...session.context, tripId: existing.id } };
  }

  await ctx.send(session.phone, {
    kind: "locationRequest",
    body: copy.customer.greeting,
  });
  return { ...session, state: "awaiting_location", context: {} };
}

async function onLocation(
  ctx: FlowContext,
  session: Session,
  lat: number,
  lng: number,
): Promise<Session> {
  const zone = await zoneForPoint(ctx.db, { lat, lng });
  const next: Session = {
    ...session,
    state: "awaiting_zone",
    context: {
      ...session.context,
      pickupLat: lat,
      pickupLng: lng,
      pickupZone: zone?.id,
    },
  };
  return sendZoneMenu(ctx, next);
}

async function sendZoneMenu(ctx: FlowContext, session: Session): Promise<Session> {
  const zones = await listZones(ctx.db);
  await ctx.send(session.phone, {
    kind: "list",
    body: copy.customer.askZone,
    buttonLabel: copy.customer.askZoneButton,
    sections: [
      {
        rows: zones
          .slice(0, WA_MAX_LIST_ROWS)
          .map((z) => ({ id: `zone:${z.id}`, title: fitRowTitle(z.name) })),
      },
    ],
  });
  return { ...session, state: "awaiting_zone" };
}

async function onZone(ctx: FlowContext, session: Session, zoneId: string): Promise<Session> {
  const next: Session = {
    ...session,
    context: { ...session.context, destZone: zoneId },
  };
  return sendLandmarkMenu(ctx, next, zoneId);
}

async function sendLandmarkMenu(
  ctx: FlowContext,
  session: Session,
  zoneId: string,
): Promise<Session> {
  const zone = await getZone(ctx.db, zoneId);
  if (!zone) return sendZoneMenu(ctx, session);

  const landmarks = await listLandmarks(ctx.db, zoneId);
  // One row is reserved for the free-text escape hatch.
  const rows = landmarks
    .slice(0, WA_MAX_LIST_ROWS - 1)
    .map((lm) => ({ id: `lm:${lm.id}`, title: fitRowTitle(lm.name) }));
  rows.push({ id: `lm:${OTHER_PLACE}`, title: copy.customer.otherPlaceRow });

  await ctx.send(session.phone, {
    kind: "list",
    body: copy.customer.askLandmark(zone.name),
    buttonLabel: copy.customer.askLandmarkButton,
    sections: [{ rows }],
  });
  return { ...session, state: "awaiting_landmark" };
}

/**
 * Free-text destination. Locals type "la terminal" as readily as they tap, and
 * the "Otro lugar…" row routes here too.
 */
async function onFreeText(ctx: FlowContext, session: Session, text: string): Promise<Session> {
  const matches = await matchLandmarkText(ctx.db, text);

  if (matches.length === 0) {
    await ctx.send(session.phone, { kind: "text", body: copy.customer.noMatch });
    return { ...session, state: "awaiting_text_confirm" };
  }

  if (matches.length === 1) {
    return onLandmark(ctx, session, matches[0]!.id);
  }

  await ctx.send(session.phone, {
    kind: "list",
    body: copy.customer.confirmMatch,
    buttonLabel: copy.customer.askLandmarkButton,
    sections: [{ rows: matches.map((lm) => ({ id: `lm:${lm.id}`, title: fitRowTitle(lm.name) })) }],
  });
  return {
    ...session,
    state: "awaiting_text_confirm",
    context: { ...session.context, textCandidates: matches.map((m) => m.id) },
  };
}

/** Destination settled — create the trip, try to assign it, quote the wait. */
async function onLandmark(
  ctx: FlowContext,
  session: Session,
  landmarkId: string,
): Promise<Session> {
  const landmark = await getLandmark(ctx.db, landmarkId);
  if (!landmark) return sendZoneMenu(ctx, session);

  const c = session.context;
  const tripId = await createHail(ctx.db, {
    customerPhone: session.phone,
    pickupLat: c.pickupLat ?? null,
    pickupLng: c.pickupLng ?? null,
    pickupZone: c.pickupZone ?? null,
    pickupLabel: null,
    destZone: landmark.zone_id,
    destLandmark: landmark.id,
    destLabel: landmark.name,
    now: ctx.now,
  });

  const assignment = await assignTrip(ctx.db, tripId, c.pickupZone ?? null, ctx.now);

  if (assignment) {
    await ctx.db
      .prepare("UPDATE trips SET quoted_wait_min = ? WHERE id = ?")
      .bind(Math.round(assignment.etaMin), tripId)
      .run();

    await ctx.send(session.phone, {
      kind: "text",
      body: copy.customer.assigned(
        assignment.driver.name,
        assignment.driver.tuktuk_no,
        Math.round(assignment.etaMin),
      ),
    });
    await ctx.notifyDriverOfTrip(assignment.driver, tripId);
  } else {
    const eta = await quoteWaitMinutes(ctx.db, c.pickupZone ?? null, ctx.now);
    await ctx.send(session.phone, { kind: "text", body: copy.customer.queued(eta) });
  }

  return {
    ...session,
    state: "waiting",
    context: { ...c, destZone: landmark.zone_id, destLandmark: landmark.id, tripId },
  };
}

async function cancel(ctx: FlowContext, session: Session): Promise<Session> {
  const trip =
    (session.context.tripId ? await getTrip(ctx.db, session.context.tripId) : null) ??
    (await activeTripForCustomer(ctx.db, session.phone));

  if (trip) await cancelTrip(ctx.db, trip.id, "customer", ctx.now);

  await ctx.send(session.phone, { kind: "text", body: copy.customer.canceled });
  return { ...session, state: "idle", context: {} };
}
