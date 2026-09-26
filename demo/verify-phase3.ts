/**
 * Phase 3's proof: the map's geometry is consistent with the domain's, and a
 * drive takes as long as the domain said it would (R3).
 *
 * Two things are checked here that a screenshot cannot settle:
 *
 *   - Every seeded place is drawable and reachable, and no drawn zone contradicts
 *     `zoneForPoint`. These are `town.ts`'s startup assertions, run in node so a
 *     gazetteer edit fails in a script rather than in front of an audience.
 *   - The arithmetic behind R3, to the millisecond. Three different numbers are
 *     involved and conflating any two of them would look fine on screen:
 *       `quoted_wait_min`  — the approach only, which is what the customer reads
 *       `available_at`     — approach + carry, which is what the board projects
 *       the animation      — the same, times the jitter
 *     Checked for a hail and again for a bandera, where the approach is zero. That
 *     second case is not symmetry for its own sake: a flagged-down passenger is
 *     already aboard, so a drive planned from a *guessed* approach put the sprite
 *     three minutes behind the board on every one of them, and nothing on screen
 *     said so.
 *
 * Run it with `npm run demo:verify:map`. The browser still has to be looked at;
 * this only proves the numbers.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import initSqlJs from "sql.js";

import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { createFlowContext, handleInbound } from "../src/domain/flow";
import type { InboundPayload } from "../src/domain/types";
import type { SqlJsD1Database } from "./src/d1";
import { openDemoDb } from "./src/db";
import { Fleet, JITTER } from "./src/fleet";
import type { Plan } from "./src/fleet";
import { createRng, DEFAULT_SEED } from "./src/rng";
import { GATEWAYS, PX_PER_KM, VIEW, ZONES, loadTown, pathLength, route, zoneOfPoint } from "./src/town";
import type { Gazetteer, Pt } from "./src/town";

const T0 = 1_699_952_400_000;
const MINUTE = 60_000;

const ANA = "50488880001";
const JOSE = "50499990001";

/** Hotel Marina, in the centre, two doors from the Parque. */
const AT_MARINA = { lat: 14.8399, lng: -89.1528 };

const transport = new MemoryTransport();
let db: SqlJsD1Database;
let town: Gazetteer;
let messageSeq = 0;
let checks = 0;

async function main(): Promise<void> {
  const SQL = await initSqlJs({ wasmBinary: loadWasm() });
  db = openDemoDb(SQL);

  // ── The town is drawable ───────────────────────────────────────────────────
  // loadTown throws on an unreachable landmark, a zone with nowhere to park, a
  // node that has drifted from the seed, a polygon outside its own Voronoi cell,
  // or a hole in the travel-time matrix.
  town = await loadTown(db);
  say("loadTown accepted the seeded gazetteer");

  const zones = await all<{ id: string; name: string }>("SELECT id, name FROM zones");
  const landmarks = await all<{ id: string; name: string; zone_id: string }>(
    "SELECT id, name, zone_id FROM landmarks WHERE active = 1",
  );

  expect("six of the seven zones are drawn as polygons", ZONES.length, 6);
  expect("…and the seventh is a gateway", gatewayFor("z:aldeas") !== null, true);
  expect("every zone has somewhere to park", zones.every((z) => town.pointForZone(z.id) !== null), true);
  expect(
    "every landmark has a position",
    landmarks.every((lm) => town.pointForLandmark(lm.id) !== null),
    true,
  );

  // Reachability the way a trip actually asks for it: a route from where a taxi
  // is parked to where the customer is going, for every pair the demo can
  // produce. A missing edge is a taxi that accepts a trip and never arrives.
  let worst = { from: "", to: "", length: 0 };
  let pairs = 0;
  for (const zone of zones) {
    const from = town.pointForZone(zone.id)!;
    for (const lm of landmarks) {
      const to = town.pointForLandmark(lm.id)!;
      const path = route(from, to);
      const length = pathLength(path);
      pairs += 1;
      const arrives = Math.hypot(last(path).x - to.x, last(path).y - to.y) < 0.6;
      if (!arrives) throw new Error(`FAILED route ${zone.id} → ${lm.id} does not end at ${lm.id}`);
      if (length > worst.length) worst = { from: zone.id, to: lm.id, length };
    }
  }
  say(`${pairs} zone→landmark routes all arrive; longest is ${worst.from} → ${worst.to} ` +
      `at ${(worst.length / PX_PER_KM).toFixed(2)} km`);
  checks += 1;

  // The drawing agrees with `zoneForPoint`: the label a viewer reads and the
  // zone the dispatcher scores from are the same zone.
  for (const zone of ZONES) {
    expect(`the "${zone.id}" label sits in ${zone.id}`, zoneOfPoint(zone.label.at), zone.id);
  }
  for (const dot of town.dots) {
    const seeded = landmarks.find((lm) => lm.id === dot.id)!;
    const drawn = zoneOfPoint(dot.at);
    if (drawn !== seeded.zone_id) {
      // Not a failure: `zoneForPoint` snaps a *pin* to the nearest centroid,
      // while a landmark row carries its own zone, and for two seeded places
      // those disagree. Reported because it is the gazetteer's problem to fix.
      console.log(
        `  ! ${dot.id}: seeded in ${seeded.zone_id}, but a pin there scores as ${drawn}`,
      );
    }
    expect(`${dot.id} is drawn inside the frame`, inFrame(dot.at), true);
  }
  for (const gateway of GATEWAYS) {
    expect(`the ${gateway.node} gateway label is inside the frame`, inFrame(gateway.label), true);
  }

  // ── R3, with numbers ──────────────────────────────────────────────────────
  const rng = createRng(DEFAULT_SEED);
  const fleet = new Fleet(db, town, rng);
  await fleet.sync(T0);

  console.log("\n  Ana hails from the Hotel Marina to the Parque Arqueológico\n");
  await beat(0, ANA, { kind: "text", text: "buenas" });
  await beat(0, ANA, { kind: "location", ...AT_MARINA });
  await beat(0, ANA, { kind: "list", id: "zone:ruinas", title: "Las Ruinas" });
  await beat(0, ANA, { kind: "list", id: "lm:parque_arq", title: "Parque Arqueológico" });

  const trip = await one<{
    id: number;
    driver_id: number;
    quoted_wait_min: number;
    assigned_at: number;
    pickup_zone_id: string;
    dest_zone_id: string;
  }>(
    `SELECT id, driver_id, quoted_wait_min, assigned_at, pickup_zone_id, dest_zone_id
       FROM trips ORDER BY id DESC LIMIT 1`,
  );
  const driver = await one<{ id: number; name: string; zone_id: string; available_at: number }>(
    "SELECT id, name, zone_id, available_at FROM drivers WHERE id = ?",
    trip.driver_id,
  );

  await fleet.sync(T0);
  const plan = fleet.planFor(trip.driver_id);
  if (!plan) throw new Error("FAILED the assigned driver has no drive planned");

  const approach = plan.legs.find((l) => l.kind === "approach")!;
  const carry = plan.legs.find((l) => l.kind === "carry")!;
  const matrixApproach = await minutes(driver.zone_id, trip.pickup_zone_id);
  const matrixLeg = await minutes(trip.pickup_zone_id, trip.dest_zone_id);

  report(trip, driver, plan, matrixApproach, matrixLeg);

  expect("the approach leg's minutes are the matrix's", plan.approachMin, matrixApproach);
  expect("the carry leg's minutes are the matrix's", plan.legMin, matrixLeg);
  expect(
    "the quote the customer read is the approach, rounded",
    trip.quoted_wait_min,
    Math.round(matrixApproach),
  );
  expect(
    "the drive starts where markDriverUnderway started counting",
    plan.origin,
    driver.available_at - (matrixApproach + matrixLeg) * MINUTE,
  );
  expect("…which is the instant the trip was assigned", plan.origin, trip.assigned_at);
  expect(
    "the whole drive is the board's projection times the jitter",
    Math.round(carry.endAt - plan.origin),
    Math.round((matrixApproach + matrixLeg) * MINUTE * plan.jitter),
  );
  expect("the approach ends where the carry begins", approach.endAt, carry.startAt);
  expect("jitter stays inside ±25%", Math.abs(plan.jitter - 1) <= JITTER + 1e-9, true);

  // The graph's only contribution is shape; speed falls out of dividing it by
  // the matrix. Only the upper bound is asserted. A slow leg is the matrix being
  // coarse — the approach here is 40 m because José was already at the Parque,
  // and the matrix still charges centro→centro three minutes — while a fast one
  // would mean the animation had found its duration somewhere other than the
  // matrix, which is the whole failure R3 exists to prevent.
  const approachKmh =
    approach.length / PX_PER_KM / ((approach.endAt - approach.startAt) / 3_600_000);
  const carryKmh = carry.length / PX_PER_KM / ((carry.endAt - carry.startAt) / 3_600_000);
  expect("nothing about the approach outruns a tuktuk", approachKmh < 40, true);
  expect("nor the carry", carryKmh > 4 && carryKmh < 40, true);

  // ── Where the sprite ends up ──────────────────────────────────────────────
  // The sprite must land where the domain will say the driver is, or the map and
  // the board disagree from the next trip onward.
  const atArrival = fleet.sample(carry.endAt).taxis.find((t) => t.driverId === driver.id)!;
  expect("the sprite ends in the destination zone", zoneOfPoint(atArrival.at), trip.dest_zone_id);

  const listoAt = T0 + Math.ceil((carry.endAt - T0) / MINUTE) * MINUTE;
  await beat(Math.ceil((carry.endAt - T0) / MINUTE), JOSE, {
    kind: "button",
    id: "drv:done",
    title: "✅ Listo",
  });
  const after = await one<{ zone_id: string; status: string }>(
    "SELECT zone_id, status FROM drivers WHERE id = ?",
    driver.id,
  );
  expect("…the same zone the domain infers after ✅ Listo", after.zone_id, trip.dest_zone_id);
  expect("…and the driver is free again", after.status, "available");

  /**
   * What the matrix learned, spelled out arithmetically rather than as "it moved".
   *
   * `learnZoneTime` measures `done_at − assigned_at` and then subtracts the
   * trip's own `approach_min`, so what reaches the pickup→dest cell is the ride
   * and not the drive across town to fetch the passenger. Leaving the approach in
   * drifted cells by ×1.22 to ×2.28 over one simulated day, because
   * `travelMinutes` reads this same cell back when it estimates the *next*
   * approach and the error then fed itself.
   *
   * The other half: a hand-seeded row carries samples = 0 and is weighted as one
   * observation rather than as none, so the first trip lands exactly midway
   * between the surveyed guess and what was driven instead of erasing it.
   *
   * What does *not* cancel is the jitter on the approach. The domain subtracts the
   * matrix's estimate of the approach, not the minutes the sprite actually spent
   * on it, so a leg driven a few per cent long leaves a few per cent of the
   * approach behind in the cell. That residue is honest rather than a demo
   * artefact — the app cannot observe an approach either, since there is no
   * "passenger aboard" button — and it is why the numbers here are derived from
   * the run instead of being round.
   */
  const stored = await one<{ approach_min: number }>(
    "SELECT approach_min FROM trips WHERE id = ?",
    trip.id,
  );
  // Also the check that says migration 0002 was applied: `markDriverUnderway`
  // writes this column on every trip, so a demo built against `0001` alone throws
  // on the first hail rather than getting here. See `demo/src/db.ts`.
  expect("the approach the domain charged is on the trip", stored.approach_min, matrixApproach);

  const learned = await minutes(trip.pickup_zone_id, trip.dest_zone_id);
  const spanMin = (listoAt - trip.assigned_at) / MINUTE;
  const observedMin = spanMin - stored.approach_min;
  console.log(
    `\n  zone_times[${trip.pickup_zone_id}→${trip.dest_zone_id}] ` +
      `${matrixLeg} → ${learned.toFixed(2)} min  ` +
      `(${spanMin.toFixed(2)} min from assignment, less ${stored.approach_min} of approach, ` +
      `blended one-for-one with the seeded ${matrixLeg})\n`,
  );
  expect(
    "learnZoneTime folds in the ride and not the approach",
    (learned * 2 - matrixLeg).toFixed(6),
    observedMin.toFixed(6),
  );
  expect(
    "…blended with the seeded guess as one observation against one, not replacing it",
    learned.toFixed(6),
    ((matrixLeg + observedMin) / 2).toFixed(6),
  );

  // Not "no drive at all": the sprite still has a few pixels to cover to reach
  // the spot it parks in, and that leg must not be mistaken for part of a trip.
  await fleet.sync(carry.endAt);
  expect("the closed trip's drive is dropped", fleet.planFor(driver.id)?.kind, "reposition");
  expect("…carrying no trip", fleet.planFor(driver.id)?.tripId, null);

  // ── A change the map did not initiate ─────────────────────────────────────
  // The map has to survive state it had no part in: here, a customer who types
  // *cancelar* while the taxi is halfway to them. The sprite must stop driving
  // to a pickup that no longer exists and head back to where the domain still
  // believes the driver is, which is the zone they never left.
  console.log("\n  Ana hails again, then cancels mid-approach\n");
  const t2 = 20;
  await beat(t2, ANA, { kind: "text", text: "otro viaje" });
  await beat(t2, ANA, { kind: "location", ...AT_MARINA });
  await beat(t2, ANA, { kind: "list", id: "zone:barrio_abajo", title: "Barrio abajo" });
  await beat(t2, ANA, { kind: "list", id: "lm:estadio", title: "Estadio" });

  const second = await one<{ id: number; driver_id: number; state: string }>(
    "SELECT id, driver_id, state FROM trips ORDER BY id DESC LIMIT 1",
  );
  await fleet.sync(T0 + t2 * MINUTE);
  expect("the new trip has the driver driving", fleet.planFor(second.driver_id)?.tripId, second.id);

  await beat(t2 + 1, ANA, { kind: "text", text: "cancelar" });
  const canceled = await one<{ state: string }>("SELECT state FROM trips WHERE id = ?", second.id);
  expect("the trip is canceled", canceled.state, "canceled");

  await fleet.sync(T0 + (t2 + 1) * MINUTE);
  const recovered = fleet.planFor(second.driver_id);
  expect("the drive to the cancelled pickup is dropped", recovered?.kind, "reposition");
  expect("…and carries no trip", recovered?.tripId, null);
  const driverAfter = await one<{ zone_id: string; status: string }>(
    "SELECT zone_id, status FROM drivers WHERE id = ?",
    second.driver_id,
  );
  expect("the driver is free again", driverAfter.status, "available");
  const parked = fleet.sample(recovered!.legs[0]!.endAt).taxis.find(
    (t) => t.driverId === second.driver_id,
  )!;
  expect("…and the sprite returns to the zone they never left", zoneOfPoint(parked.at), driverAfter.zone_id);

  // ── A trip off the edge of the map ────────────────────────────────────────
  console.log("\n  Ana hails from the Parque Central to Agua Caliente\n");
  const t1 = 40;
  await beat(t1, ANA, { kind: "text", text: "otra vez" });
  await beat(t1, ANA, { kind: "location", lat: 14.8397, lng: -89.1531 });
  await beat(t1, ANA, { kind: "list", id: "zone:aldeas", title: "Aldeas / afueras" });
  await beat(t1, ANA, { kind: "list", id: "lm:agua_caliente", title: "Agua Caliente" });

  const far = await one<{ id: number; driver_id: number; dest_zone_id: string }>(
    "SELECT id, driver_id, dest_zone_id FROM trips ORDER BY id DESC LIMIT 1",
  );
  await fleet.sync(T0 + t1 * MINUTE);
  const farPlan = fleet.planFor(far.driver_id);
  if (!farPlan) throw new Error("FAILED the trip to Agua Caliente has no drive planned");

  const farCarry = farPlan.legs.find((l) => l.kind === "carry")!;
  expect("the drive out of town takes the matrix's 18 minutes", farPlan.legMin, 18);
  const leaving = fleet.sample(farCarry.startAt + (farCarry.endAt - farCarry.startAt) * 0.9);
  const sprite = leaving.taxis.find((t) => t.driverId === far.driver_id)!;
  expect("the taxi fades as it leaves the frame", sprite.opacity < 0.9, true);
  expect("…heading for the Agua Caliente gateway", nearestGateway(sprite.at), "agua_caliente");

  // ── R3 for a passenger who is already aboard ──────────────────────────────
  //
  // The case the arithmetic above cannot catch, and the one it was quietly wrong
  // about. A bandera has no approach: the passenger flagged the driver down, so the
  // pickup zone *is* the driver's own zone, and `travelMinutes` would hand back the
  // same-zone value — about three minutes — for a drive that never happens. The
  // domain charges zero for it now, and the sprite has to agree, or the taxi arrives
  // three minutes after the board says the driver is free and R3 is false in the one
  // direction nothing on screen would say.
  console.log("\n  A driver is flagged down in the street\n");
  const t3 = 70;
  const free = await one<{ id: number; phone: string; name: string; zone_id: string }>(
    "SELECT id, phone, name, zone_id FROM drivers WHERE status = 'available' ORDER BY id LIMIT 1",
  );
  // Somewhere other than where they are standing, so the carry is a real drive and
  // not the same-zone minimum the bug used to invent.
  const banderaDest = free.zone_id === "ruinas" ? "centro" : "ruinas";

  await beat(t3, free.phone, { kind: "button", id: "drv:bandera", title: "✋ Bandera" });
  await beat(t3, free.phone, { kind: "list", id: `bzone:${banderaDest}`, title: banderaDest });

  const flagged = await one<{
    id: number;
    source: string;
    approach_min: number;
    assigned_at: number;
    pickup_zone_id: string;
    dest_zone_id: string;
  }>(
    `SELECT id, source, approach_min, assigned_at, pickup_zone_id, dest_zone_id
       FROM trips ORDER BY id DESC LIMIT 1`,
  );
  expect("the ✋ logged a bandera", flagged.source, "bandera");
  expect("…picked up where the driver was standing", flagged.pickup_zone_id, free.zone_id);
  expect("…and charged no approach, because nobody had to be fetched", flagged.approach_min, 0);

  const banderaLeg = await minutes(flagged.pickup_zone_id, flagged.dest_zone_id);
  const onBoard = await one<{ available_at: number }>(
    "SELECT available_at FROM drivers WHERE id = ?",
    free.id,
  );
  expect(
    "the board frees the driver after the ride alone",
    (onBoard.available_at - flagged.assigned_at) / MINUTE,
    banderaLeg,
  );

  await fleet.sync(T0 + t3 * MINUTE);
  const carried = fleet.planFor(free.id);
  if (!carried) throw new Error("FAILED the bandera has no drive planned");
  expect("the drive reads the approach off the trip rather than guessing it", carried.approachMin, 0);
  expect("…so there is one leg and it is the carry", carried.legs.map((l) => l.kind).join(","), "carry");
  expect("…starting the instant the domain began counting", carried.origin, flagged.assigned_at);

  const ride = carried.legs[0]!;
  expect("…and running the matrix's minutes, times the jitter", carried.legMin, banderaLeg);
  expect(
    "the sprite arrives when the board says the driver is free, give or take the jitter",
    ((ride.endAt - carried.origin) / MINUTE / banderaLeg).toFixed(4),
    carried.jitter.toFixed(4),
  );
  console.log(
    `  ${free.name}, already carrying: ${banderaLeg} matrix min, ` +
      `jitter ${carried.jitter.toFixed(4)}, drive ${((ride.endAt - carried.origin) / MINUTE).toFixed(2)} min, ` +
      `board ${((onBoard.available_at - flagged.assigned_at) / MINUTE).toFixed(2)} min\n`,
  );

  console.log(`\n${checks} checks passed. The map's geometry and the domain's agree.\n`);
  db.close();
}

// ── Reporting ────────────────────────────────────────────────────────────────

function report(
  trip: { quoted_wait_min: number; assigned_at: number },
  driver: { name: string; zone_id: string; available_at: number },
  plan: Plan,
  matrixApproach: number,
  matrixLeg: number,
): void {
  const approach = plan.legs.find((l) => l.kind === "approach")!;
  const carry = plan.legs.find((l) => l.kind === "carry")!;
  const min = (ms: number): string => (ms / MINUTE).toFixed(2).padStart(6);

  console.log(`  ${driver.name}, last seen in ${driver.zone_id}`);
  console.log(`  matrix: approach ${matrixApproach} min, carry ${matrixLeg} min` +
              `   jitter ${plan.jitter.toFixed(4)}`);
  console.log(`  quoted to the customer      ${String(trip.quoted_wait_min).padStart(6)} min` +
              `   (the approach, rounded)`);
  console.log(`  available_at projects       ${min(driver.available_at - trip.assigned_at)} min`);
  console.log(`  animated approach           ${min(approach.endAt - approach.startAt)} min` +
              `   over ${(approach.length / PX_PER_KM).toFixed(2)} km`);
  console.log(`  animated carry              ${min(carry.endAt - carry.startAt)} min` +
              `   over ${(carry.length / PX_PER_KM).toFixed(2)} km`);
  console.log(`  animated total              ${min(carry.endAt - plan.origin)} min`);
  console.log(`  board vs. drive             ${min(
    carry.endAt - plan.origin - (driver.available_at - trip.assigned_at),
  )} min   (the jitter, and nothing else)\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function beat(minute: number, from: string, payload: InboundPayload): Promise<void> {
  const at = T0 + minute * MINUTE;
  await handleInbound(createFlowContext(db, transport, at), {
    from,
    messageId: `demo.${++messageSeq}`,
    at,
    payload,
  });
}

function inFrame(p: Pt): boolean {
  return p.x >= 0 && p.x <= VIEW.w && p.y >= 0 && p.y <= VIEW.h;
}

function gatewayFor(node: string): (typeof GATEWAYS)[number] | null {
  return GATEWAYS.find((g) => g.node === node) ?? null;
}

function nearestGateway(p: Pt): string {
  let best = GATEWAYS[0]!;
  let bestD = Infinity;
  for (const g of GATEWAYS) {
    const d = Math.hypot(p.x - g.tip.x, p.y - g.tip.y);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best.node;
}

function last(path: Pt[]): Pt {
  return path[path.length - 1]!;
}

async function minutes(from: string, to: string): Promise<number> {
  return (
    await one<{ minutes: number }>(
      "SELECT minutes FROM zone_times WHERE from_zone = ? AND to_zone = ?",
      from,
      to,
    )
  ).minutes;
}

async function one<T>(sql: string, ...params: unknown[]): Promise<T> {
  const found = await db.prepare(sql).bind(...params).first<T>();
  if (found === null) throw new Error(`no row for: ${sql}`);
  return found;
}

async function all<T>(sql: string): Promise<T[]> {
  return (await db.prepare(sql).all<T>()).results;
}

function expect<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`FAILED ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function say(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function loadWasm(): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(readFileSync(join(dirname(require.resolve("sql.js")), "sql-wasm.wasm")));
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
