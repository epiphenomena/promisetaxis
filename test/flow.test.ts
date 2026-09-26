/**
 * The conversations end to end, with no network and no phones.
 *
 * Every one of these runs against real local D1 through the same state machines
 * production uses — only the transport is swapped. That substitutability is the
 * entire reason the adapter boundary exists.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { renderOutbound } from "../src/adapters/whatsapp/outbound";
import { WA_MAX_ROW_TITLE, type OutboundMessage } from "../src/domain/types";
import { copy } from "../src/domain/copy";
import { rankCandidates } from "../src/domain/dispatch";
import {
  AT, CUSTOMER, DRIVER_JOSE, DRIVER_MARVIN, DRIVER_ROSA, T0,
  hail, inbound, makeCtx, setupDb,
} from "./helpers";

let tx: MemoryTransport;

beforeEach(async () => {
  await setupDb();
  tx = new MemoryTransport();
});

const kinds = (msgs: OutboundMessage[]) => msgs.map((m) => m.spec.kind);

describe("customer hail", () => {
  it("walks text → location → zone → landmark in two taps", async () => {
    const ctx = makeCtx(tx);

    await inbound(ctx, CUSTOMER, { kind: "text", text: "necesito un tuktuk" });
    expect(kinds(tx.to(CUSTOMER))).toEqual(["locationRequest"]);

    await inbound(ctx, CUSTOMER, { kind: "location", ...AT.parqueCentral });
    const zoneMenu = tx.last(CUSTOMER)!;
    expect(zoneMenu.spec.kind).toBe("list");
    if (zoneMenu.spec.kind !== "list") throw new Error("expected list");
    expect(zoneMenu.spec.sections[0]!.rows.map((r) => r.id)).toContain("zone:ruinas");

    await inbound(ctx, CUSTOMER, { kind: "list", id: "zone:ruinas", title: "Las Ruinas" });
    const lmMenu = tx.last(CUSTOMER)!;
    if (lmMenu.spec.kind !== "list") throw new Error("expected list");
    const rows = lmMenu.spec.sections[0]!.rows;
    expect(rows.map((r) => r.id)).toContain("lm:parque_arq");
    // One row is always reserved for the free-text escape hatch.
    expect(rows[rows.length - 1]!.id).toBe("lm:__other__");

    await inbound(ctx, CUSTOMER, { kind: "list", id: "lm:parque_arq", title: "Parque Arqueológico" });
    const confirm = tx.last(CUSTOMER)!;
    if (confirm.spec.kind !== "text") throw new Error("expected text");
    expect(confirm.spec.body).toContain("Don José");
  });

  it("records the exact pin while routing on the zone", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    const trip = await env.DB.prepare(
      "SELECT pickup_lat, pickup_lng, pickup_zone_id, dest_zone_id FROM trips WHERE customer_phone = ?",
    )
      .bind(CUSTOMER)
      .first<{ pickup_lat: number; pickup_lng: number; pickup_zone_id: string; dest_zone_id: string }>();

    expect(trip?.pickup_lat).toBeCloseTo(AT.parqueCentral.lat, 4);
    expect(trip?.pickup_zone_id).toBe("centro");
    expect(trip?.dest_zone_id).toBe("ruinas");
  });

  it("hands the driver the customer's pin, not just the landmark name", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    const toJose = tx.to(DRIVER_JOSE);
    expect(kinds(toJose)).toEqual(["buttons", "location"]);

    const pin = toJose[1]!;
    if (pin.spec.kind !== "location") throw new Error("expected location");
    expect(pin.spec.lat).toBeCloseTo(AT.parqueCentral.lat, 4);
  });

  it("accepts a typed landmark for phones with GPS off", async () => {
    const ctx = makeCtx(tx);
    await inbound(ctx, CUSTOMER, { kind: "text", text: "necesito un tuktuk" });
    await inbound(ctx, CUSTOMER, { kind: "location", ...AT.parqueCentral });
    // "la terminal" is an alias, not the landmark's name.
    await inbound(ctx, CUSTOMER, { kind: "text", text: "la terminal" });

    const trip = await env.DB.prepare(
      "SELECT dest_landmark_id FROM trips WHERE customer_phone = ?",
    )
      .bind(CUSTOMER)
      .first<{ dest_landmark_id: string }>();
    expect(trip?.dest_landmark_id).toBe("terminal");
  });

  it("trims an over-long landmark name rather than losing the whole menu", async () => {
    // The name the first gazetteer shipped with: 26 characters against a 24-char
    // ceiling the renderer enforces by throwing. Thrown, it rejects the entire
    // Barrio arriba list, so the customer gets no reply at all and the
    // conversation dead-ends — in the zone with the hospital in it.
    await env.DB.prepare(
      `INSERT INTO landmarks (id, zone_id, name, aliases, lat, lng, sort_order)
       VALUES ('centro_salud', 'barrio_arriba', 'Hospital / Centro de salud', 'salud', 14.8428, -89.1549, 9)`,
    ).run();

    const ctx = makeCtx(tx);
    await inbound(ctx, CUSTOMER, { kind: "text", text: "necesito un tuktuk" });
    await inbound(ctx, CUSTOMER, { kind: "location", ...AT.parqueCentral });
    await inbound(ctx, CUSTOMER, { kind: "list", id: "zone:barrio_arriba", title: "Barrio arriba" });

    const menu = tx.last(CUSTOMER)!;
    if (menu.spec.kind !== "list") throw new Error("expected list");
    const row = menu.spec.sections[0]!.rows.find((r) => r.id === "lm:centro_salud")!;

    expect([...row.title].length).toBe(WA_MAX_ROW_TITLE);
    expect(row.title.endsWith("…")).toBe(true);
    // The assertion in the renderer stays the backstop, and must not be what data
    // trips over: the menu still goes out, with the other landmarks intact.
    expect(() => renderOutbound(menu)).not.toThrow();
    expect(menu.spec.sections[0]!.rows.map((r) => r.id)).toContain("lm:hospital");
  });

  it("cancels on request and frees the driver it had claimed", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    await inbound(ctx, CUSTOMER, { kind: "text", text: "cancelar" });

    const trip = await env.DB.prepare(
      "SELECT state FROM trips WHERE customer_phone = ?",
    ).bind(CUSTOMER).first<{ state: string }>();
    expect(trip?.state).toBe("canceled");

    const jose = await env.DB.prepare("SELECT status FROM drivers WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first<{ status: string }>();
    expect(jose?.status).toBe("available");
  });
});

describe("driver loop", () => {
  it("infers position from ✅ Listo instead of asking for GPS", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    // Don José started in centro; after finishing a trip to the ruins he is
    // at the ruins, and nobody sent a location message to establish that.
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "✅ Listo" });

    const jose = await env.DB.prepare(
      "SELECT status, zone_id FROM drivers WHERE phone = ?",
    ).bind(DRIVER_JOSE).first<{ status: string; zone_id: string }>();

    expect(jose?.zone_id).toBe("ruinas");
    expect(jose?.status).toBe("available");
  });

  it("chains the next pickup straight into ✅ Listo", async () => {
    const ctx = makeCtx(tx);

    // Occupy every driver so the second hail has to queue.
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");
    for (const phone of [DRIVER_MARVIN, DRIVER_ROSA]) {
      await inbound(ctx, phone, { kind: "button", id: "drv:break", title: "☕ Descanso" });
    }

    const waiting = "50488880009";
    await hail(ctx, waiting, AT.ruinas, "centro", "mercado");
    const queued = await env.DB.prepare(
      "SELECT state FROM trips WHERE customer_phone = ?",
    ).bind(waiting).first<{ state: string }>();
    expect(queued?.state).toBe("pending");

    tx.clear();
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "✅ Listo" });

    // He finished at the ruins and the waiting customer is at the ruins, so
    // the queued trip comes straight back to him.
    const kindsToJose = kinds(tx.to(DRIVER_JOSE));
    expect(kindsToJose).toContain("buttons");

    const trip = await env.DB.prepare(
      `SELECT t.state, d.phone FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE t.customer_phone = ?`,
    ).bind(waiting).first<{ state: string; phone: string }>();

    expect(trip?.phone).toBe(DRIVER_JOSE);
    // Stays 'assigned' through to done — there is no "picked up" tap in the
    // driver interface, and inventing one would put the trip past the point a
    // customer can still cancel.
    expect(trip?.state).toBe("assigned");
  });

  it("logs a bandera with its destination zone", async () => {
    const ctx = makeCtx(tx);

    await inbound(ctx, DRIVER_MARVIN, { kind: "button", id: "drv:bandera", title: "✋ Bandera" });
    const menu = tx.last(DRIVER_MARVIN)!;
    expect(menu.spec.kind).toBe("list");

    await inbound(ctx, DRIVER_MARVIN, { kind: "list", id: "bzone:centro", title: "Centro" });

    const trip = await env.DB.prepare(
      `SELECT source, state, dest_zone_id, customer_phone FROM trips
       WHERE driver_id = (SELECT id FROM drivers WHERE phone = ?)`,
    ).bind(DRIVER_MARVIN).first<{
      source: string; state: string; dest_zone_id: string; customer_phone: string | null;
    }>();

    expect(trip?.source).toBe("bandera");
    expect(trip?.dest_zone_id).toBe("centro");
    // A flagged-down passenger has no phone in the system at all.
    expect(trip?.customer_phone).toBeNull();
  });

  it("takes a driver out of dispatch while on break", async () => {
    const ctx = makeCtx(tx);
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:break", title: "☕ Descanso" });

    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    const trip = await env.DB.prepare(
      `SELECT d.phone FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE t.customer_phone = ?`,
    ).bind(CUSTOMER).first<{ phone: string }>();

    expect(trip?.phone).not.toBe(DRIVER_JOSE);
  });

  it("refuses a break mid-trip rather than orphaning the trip", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:break", title: "☕ Descanso" });

    const jose = await env.DB.prepare("SELECT status FROM drivers WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first<{ status: string }>();
    // An orphaned trip compounds: the next Listo would close the stale trip
    // and inherit its destination as the driver's position.
    expect(jose?.status).not.toBe("break");

    const trip = await env.DB.prepare(
      "SELECT state FROM trips WHERE customer_phone = ?",
    ).bind(CUSTOMER).first<{ state: string }>();
    expect(trip?.state).toBe("assigned");
  });

  it("accepts typed keywords when buttons fail", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    await inbound(ctx, DRIVER_JOSE, { kind: "text", text: "LISTO" });

    const trip = await env.DB.prepare(
      "SELECT state FROM trips WHERE customer_phone = ?",
    ).bind(CUSTOMER).first<{ state: string }>();
    expect(trip?.state).toBe("done");
  });
});

describe("shift start", () => {
  it("never says a driver is available while dispatch is ignoring them", async () => {
    const ctx = makeCtx(tx);
    // How the roster leaves every driver it registers, and how they sit overnight.
    await env.DB.prepare("UPDATE drivers SET status='off' WHERE phone=?")
      .bind(DRIVER_MARVIN)
      .run();

    await inbound(ctx, DRIVER_MARVIN, { kind: "text", text: "buenas" });

    const last = tx.last(DRIVER_MARVIN)!;
    if (last.spec.kind !== "buttons") throw new Error("expected buttons");
    expect(last.spec.body).toBe(copy.driver.idle);

    // The bot just told him he is available, so dispatch has to agree with it.
    // The pairing is the bug: sendStatus said this to an 'off' driver that
    // rankCandidates skipped, and nothing in the conversation revealed it.
    const ranked = await rankCandidates(env.DB, "barrio_arriba", T0);
    expect(ranked.map((c) => c.driver.phone)).toContain(DRIVER_MARVIN);
  });

  it("logs the shift start for the office's break reporting", async () => {
    const ctx = makeCtx(tx);
    await env.DB.prepare("UPDATE drivers SET status='off' WHERE phone=?")
      .bind(DRIVER_MARVIN)
      .run();

    await inbound(ctx, DRIVER_MARVIN, { kind: "text", text: "buenas" });

    const event = await env.DB.prepare(
      `SELECT status, at FROM status_events
       WHERE driver_id = (SELECT id FROM drivers WHERE phone = ?)`,
    ).bind(DRIVER_MARVIN).first<{ status: string; at: number }>();

    expect(event?.status).toBe("available");
    expect(event?.at).toBe(T0);
  });

  it("honours a first message of 'descanso' instead of swallowing it", async () => {
    const ctx = makeCtx(tx);
    await env.DB.prepare("UPDATE drivers SET status='off' WHERE phone=?")
      .bind(DRIVER_JOSE)
      .run();

    await inbound(ctx, DRIVER_JOSE, { kind: "text", text: "descanso" });

    const jose = await env.DB.prepare("SELECT status FROM drivers WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first<{ status: string }>();
    // Starting the shift must not consume the message that started it.
    expect(jose?.status).toBe("break");

    const { results } = await env.DB.prepare(
      `SELECT status FROM status_events
       WHERE driver_id = (SELECT id FROM drivers WHERE phone = ?) ORDER BY id`,
    ).bind(DRIVER_JOSE).all<{ status: string }>();
    expect(results.map((r) => r.status)).toEqual(["available", "break"]);
  });

  it("asks for a location when a shift starts with no known position", async () => {
    const ctx = makeCtx(tx);
    // A home zone is optional on the roster, and an unknown position is scored
    // with travelMinutes' flat 10-minute fallback from everywhere in town.
    await env.DB.prepare(
      "UPDATE drivers SET status='off', zone_id=NULL, projected_zone_id=NULL WHERE phone=?",
    ).bind(DRIVER_JOSE).run();

    await inbound(ctx, DRIVER_JOSE, { kind: "text", text: "buenas" });

    const bodies = tx.to(DRIVER_JOSE).map((m) => ("body" in m.spec ? m.spec.body : ""));
    expect(bodies).toContain(copy.driver.askLocation);
  });

  it("does not ask for a location when the first message is itself a pin", async () => {
    const ctx = makeCtx(tx);
    await env.DB.prepare(
      "UPDATE drivers SET status='off', zone_id=NULL, projected_zone_id=NULL WHERE phone=?",
    ).bind(DRIVER_JOSE).run();

    await inbound(ctx, DRIVER_JOSE, { kind: "location", ...AT.estadio });

    // Asking for what just arrived reads as a bot that is not listening.
    const bodies = tx.to(DRIVER_JOSE).map((m) => ("body" in m.spec ? m.spec.body : ""));
    expect(bodies).not.toContain(copy.driver.askLocation);

    const jose = await env.DB.prepare("SELECT status, zone_id FROM drivers WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first<{ status: string; zone_id: string }>();
    expect(jose?.status).toBe("available");
    expect(jose?.zone_id).toBe("barrio_abajo");
  });
});

describe("webhook redelivery", () => {
  it("ignores a duplicate message id so a replayed Listo closes one trip", async () => {
    const ctx = makeCtx(tx);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    // Meta retries when it does not see a fast 200. The same Listo arriving
    // twice must not also close whatever trip came next.
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "Listo" },
      { messageId: "wamid.retry" });
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "Listo" },
      { messageId: "wamid.retry" });

    const { results } = await env.DB.prepare(
      "SELECT id FROM events WHERE message_id = 'wamid.retry'",
    ).all();
    expect(results).toHaveLength(1);
  });
});

describe("service window", () => {
  it("reopens the free 24h window on every inbound message", async () => {
    const ctx = makeCtx(tx, T0);
    await inbound(ctx, CUSTOMER, { kind: "text", text: "hola" });

    const session = await env.DB.prepare(
      "SELECT window_expires_at FROM sessions WHERE phone = ?",
    ).bind(CUSTOMER).first<{ window_expires_at: number }>();

    expect(session?.window_expires_at).toBe(T0 + 24 * 60 * 60 * 1000);
  });
});
