/**
 * Scoring and the assignment race.
 *
 * The race test is the reason `isolatedStorage` is on: it fires concurrent
 * claims at one driver and asserts exactly one wins, which is only meaningful
 * against a real database that another test cannot perturb.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { assignTrip, claimDriver, rankCandidates } from "../src/domain/dispatch";
import { createHail, completeTrip, getTrip, markDriverUnderway } from "../src/domain/trips";
import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import {
  AT, CUSTOMER, DRIVER_JOSE, DRIVER_MARVIN, DRIVER_ROSA, T0,
  hail, inbound, makeCtx, setupDb,
} from "./helpers";

beforeEach(setupDb);

async function driverId(phone: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM drivers WHERE phone = ?")
    .bind(phone)
    .first<{ id: number }>();
  return row!.id;
}

async function newTrip(pickupZone: string, destZone: string): Promise<number> {
  return createHail(env.DB, {
    customerPhone: "50488880001",
    pickupLat: null, pickupLng: null,
    pickupZone, pickupLabel: null,
    destZone, destLandmark: null, destLabel: "destino",
    now: T0,
  });
}

describe("scoring", () => {
  it("ranks by time-until-free plus approach time", async () => {
    // Seeded: José in centro, Marvin in barrio_arriba, Rosa at the ruins.
    // For a pickup at the ruins: Rosa 3 min, José 7, Marvin 10.
    const ranked = await rankCandidates(env.DB, "ruinas", T0);
    expect(ranked.map((r) => r.driver.phone)).toEqual([
      DRIVER_ROSA, DRIVER_JOSE, DRIVER_MARVIN,
    ]);
    expect(ranked[0]!.score).toBe(3);
  });

  it("scores a busy driver from where they will be, not where they are", async () => {
    // Send José from centro to the ruins. Mid-trip he is nominally "in centro",
    // but for a customer waiting at the ruins he is the right answer.
    const tripId = await newTrip("centro", "ruinas");
    await claimDriver(env.DB, await driverId(DRIVER_JOSE), tripId, T0);
    const trip = await getTrip(env.DB, tripId);
    await markDriverUnderway(env.DB, trip!, T0);

    const ranked = await rankCandidates(env.DB, "ruinas", T0);
    const jose = ranked.find((r) => r.driver.phone === DRIVER_JOSE)!;

    expect(jose.driver.projected_zone_id).toBe("ruinas");
    // centro→centro approach (3) + centro→ruinas leg (7) before he is free,
    // and then he is already at the ruins where the next customer is waiting.
    expect(jose.waitMin).toBeCloseTo(10, 1);
    expect(jose.approachMin).toBe(3);
  });

  it("breaks near-ties toward the driver idle longest", async () => {
    const jose = await driverId(DRIVER_JOSE);
    const marvin = await driverId(DRIVER_MARVIN);

    // Put both in centro so their scores are identical, with Marvin idle longer.
    await env.DB.batch([
      env.DB.prepare("UPDATE drivers SET zone_id='centro', projected_zone_id='centro', idle_since=? WHERE id=?")
        .bind(T0, jose),
      env.DB.prepare("UPDATE drivers SET zone_id='centro', projected_zone_id='centro', idle_since=? WHERE id=?")
        .bind(T0 - 60 * 60 * 1000, marvin),
    ]);

    const ranked = await rankCandidates(env.DB, "centro", T0);
    expect(ranked[0]!.driver.phone).toBe(DRIVER_MARVIN);
  });

  it("excludes drivers on break entirely", async () => {
    await env.DB.prepare("UPDATE drivers SET status='break' WHERE phone=?")
      .bind(DRIVER_ROSA)
      .run();

    const ranked = await rankCandidates(env.DB, "ruinas", T0);
    expect(ranked.map((r) => r.driver.phone)).not.toContain(DRIVER_ROSA);
  });

  it("quotes a sane wait for a driver who came back from a break", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);

    await inbound(ctx, DRIVER_ROSA, { kind: "button", id: "drv:break", title: "Descanso" });
    // Any route back to 'available' must leave a usable available_at behind —
    // a far-future sentinel here would surface to a customer as the wait quote.
    await env.DB.prepare("UPDATE drivers SET status='available' WHERE phone=?")
      .bind(DRIVER_ROSA)
      .run();

    const ranked = await rankCandidates(env.DB, "ruinas", T0);
    const rosa = ranked.find((r) => r.driver.phone === DRIVER_ROSA)!;
    expect(rosa.score).toBeLessThan(60);
  });
});

describe("claim race", () => {
  it("lets exactly one of two concurrent claims win", async () => {
    const jose = await driverId(DRIVER_JOSE);
    const tripA = await newTrip("centro", "ruinas");
    const tripB = await newTrip("centro", "ruinas");

    const [a, b] = await Promise.all([
      claimDriver(env.DB, jose, tripA, T0),
      claimDriver(env.DB, jose, tripB, T0),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);

    const claimed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trips WHERE driver_id = ? AND state = 'assigned'",
    ).bind(jose).first<{ n: number }>();
    expect(claimed?.n).toBe(1);
  });

  it("releases the driver when the trip was taken first", async () => {
    const jose = await driverId(DRIVER_JOSE);
    const marvin = await driverId(DRIVER_MARVIN);
    const tripId = await newTrip("centro", "ruinas");

    expect(await claimDriver(env.DB, marvin, tripId, T0)).toBe(true);
    // José tries for a trip that is no longer pending.
    expect(await claimDriver(env.DB, jose, tripId, T0)).toBe(false);

    const joseRow = await env.DB.prepare("SELECT status FROM drivers WHERE id = ?")
      .bind(jose)
      .first<{ status: string }>();
    // He must not be stranded in 'assigned' with nothing to do.
    expect(joseRow?.status).toBe("available");
  });

  it("falls through to the next-best driver when the first is taken", async () => {
    const rosa = await driverId(DRIVER_ROSA);
    await env.DB.prepare("UPDATE drivers SET status='assigned' WHERE id=?").bind(rosa).run();

    const tripId = await newTrip("ruinas", "centro");
    const result = await assignTrip(env.DB, tripId, "ruinas", T0);

    // Rosa was closest but unavailable, so José takes it.
    expect(result?.driver.phone).toBe(DRIVER_JOSE);
  });
});

describe("travel-time learning", () => {
  it("blends the first observation into the hand-seeded guess", async () => {
    const tripId = await newTrip("centro", "ruinas");
    await claimDriver(env.DB, await driverId(DRIVER_JOSE), tripId, T0);

    const trip = await getTrip(env.DB, tripId);
    // Took 12 minutes in reality; the seed said 7.
    await completeTrip(env.DB, trip!, T0 + 12 * 60 * 1000);

    const row = await env.DB.prepare(
      "SELECT minutes, samples FROM zone_times WHERE from_zone='centro' AND to_zone='ruinas'",
    ).first<{ minutes: number; samples: number }>();

    expect(row?.samples).toBe(1);
    // samples = 0 means "hand-seeded", not "worthless": the surveyed 7 is worth
    // one observation, so this refines it to 9.5 rather than declaring 12 the
    // town's travel time on the strength of a single fare behind a slow truck.
    expect(row?.minutes).toBeCloseTo(9.5, 2);
  });

  it("learns the carry leg, not the drive to the passenger", async () => {
    // Only Rosa is free, and she is at the ruins: reaching a centro pickup costs
    // her the matrix's 7 minutes before the fare has even begun.
    await env.DB.prepare("UPDATE drivers SET status='break' WHERE phone IN (?, ?)")
      .bind(DRIVER_JOSE, DRIVER_MARVIN)
      .run();

    const tripId = await newTrip("centro", "barrio_abajo");
    await claimDriver(env.DB, await driverId(DRIVER_ROSA), tripId, T0);
    await markDriverUnderway(env.DB, (await getTrip(env.DB, tripId))!, T0);

    // Re-read: markDriverUnderway is what records the approach, and learning
    // subtracts what it finds on the row it is handed.
    const trip = await getTrip(env.DB, tripId);
    expect(trip?.approach_min).toBe(7);

    // 7 minutes over to the pickup, then 12 carrying the passenger.
    await completeTrip(env.DB, trip!, T0 + 19 * 60 * 1000);

    const row = await env.DB.prepare(
      "SELECT minutes, samples FROM zone_times WHERE from_zone='centro' AND to_zone='barrio_abajo'",
    ).first<{ minutes: number; samples: number }>();

    // Seeded 5 blended with the 12-minute carry. Feeding the whole 19-minute span
    // in would teach this cell 12 — and travelMinutes reads this very cell back to
    // estimate the next approach, which is how the error compounds trip by trip.
    expect(row?.minutes).toBeCloseTo(8.5, 2);
    expect(row?.samples).toBe(1);
  });

  it("teaches a bandera its carry leg with no phantom approach", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);

    // Marvin is in barrio_arriba and someone flags him down there.
    await inbound(ctx, DRIVER_MARVIN, { kind: "button", id: "drv:bandera", title: "✋ Bandera" });
    await inbound(ctx, DRIVER_MARVIN, { kind: "list", id: "bzone:centro", title: "Centro" });

    const marvin = await env.DB.prepare(
      "SELECT available_at FROM drivers WHERE phone = ?",
    ).bind(DRIVER_MARVIN).first<{ available_at: number }>();
    // The passenger is already aboard, so the only leg is barrio_arriba→centro (4).
    // Charging him the same-zone approach as well made him look busy for 7.
    expect(marvin?.available_at).toBe(T0 + 4 * 60 * 1000);

    const trip = await env.DB.prepare(
      `SELECT approach_min FROM trips
       WHERE driver_id = (SELECT id FROM drivers WHERE phone = ?)`,
    ).bind(DRIVER_MARVIN).first<{ approach_min: number }>();
    expect(trip?.approach_min).toBe(0);

    // Dropped off 9 minutes after he flagged it, every minute of it carrying.
    await inbound(makeCtx(tx, T0 + 9 * 60 * 1000), DRIVER_MARVIN, {
      kind: "button", id: "drv:done", title: "✅ Listo",
    });

    const row = await env.DB.prepare(
      "SELECT minutes, samples FROM zone_times WHERE from_zone='barrio_arriba' AND to_zone='centro'",
    ).first<{ minutes: number; samples: number }>();

    // Seeded 4, blended with the 9-minute carry.
    expect(row?.minutes).toBeCloseTo(6.5, 2);
    expect(row?.samples).toBe(1);
  });

  it("ignores a trip left open overnight", async () => {
    const tripId = await newTrip("centro", "ruinas");
    await claimDriver(env.DB, await driverId(DRIVER_JOSE), tripId, T0);

    const trip = await getTrip(env.DB, tripId);
    // Driver forgot to tap Listo until the next morning — folding 14 hours
    // into the matrix would poison every future estimate for this pair.
    await completeTrip(env.DB, trip!, T0 + 14 * 60 * 60 * 1000);

    const row = await env.DB.prepare(
      "SELECT minutes, samples FROM zone_times WHERE from_zone='centro' AND to_zone='ruinas'",
    ).first<{ minutes: number; samples: number }>();

    expect(row?.samples).toBe(0);
    expect(row?.minutes).toBe(7);
  });
});

describe("projection after a customer hail", () => {
  it("marks the assigned driver as busy and heading to the destination", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);

    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    const jose = await env.DB.prepare(
      "SELECT status, projected_zone_id, available_at FROM drivers WHERE phone = ?",
    ).bind(DRIVER_JOSE).first<{ status: string; projected_zone_id: string; available_at: number }>();

    // He is driving to the ruins, so he must not be scored as free in centro.
    expect(jose?.projected_zone_id).toBe("ruinas");
    // centro→centro approach (3) + centro→ruinas leg (7).
    expect(jose?.available_at).toBe(T0 + 10 * 60 * 1000);
  });

  it("counts the approach leg, not just the trip itself", async () => {
    // Rosa is at the ruins; the pickup is in centro. She must be projected as
    // busy for the drive over (7) plus the trip back (7), not just the trip.
    await env.DB.prepare(
      "UPDATE drivers SET status='break' WHERE phone IN (?, ?)",
    ).bind(DRIVER_JOSE, DRIVER_MARVIN).run();

    const tripId = await newTrip("centro", "centro");
    await claimDriver(env.DB, await driverId(DRIVER_ROSA), tripId, T0);
    const trip = await getTrip(env.DB, tripId);
    await markDriverUnderway(env.DB, trip!, T0);

    const rosa = await env.DB.prepare(
      "SELECT available_at FROM drivers WHERE phone = ?",
    ).bind(DRIVER_ROSA).first<{ available_at: number }>();

    // ruinas→centro approach (7) + centro→centro leg (3).
    expect(rosa?.available_at).toBe(T0 + 10 * 60 * 1000);
  });
});
