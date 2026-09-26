/**
 * What the map should show, derived from what the database says (R2).
 *
 * Nothing in here writes. A taxi moves because `drivers` and `trips` say that
 * driver is on a trip, and the sprite reaching the destination is an *output* —
 * it is what will prompt an NPC to tap ✅ Listo in phase 5, and that tap goes in
 * through the queue like any other inbound event (R1). The reverse direction
 * does not exist: no animation ever completes a trip.
 *
 * The timing is the load-bearing part (R3). The road graph decides the shape of
 * a path and contributes nothing to how long it takes; the duration comes from
 * the domain's own zone matrix, recovered from the projection `markDriverUnderway`
 * already wrote:
 *
 *     available_at = now + (approachMin + legMin) × 60000
 *
 * so `available_at − (approachMin + legMin) × 60000` is the instant the domain
 * started counting, to the millisecond, with no dependence on which frame this
 * file happened to notice the trip. Sprite speed is then
 * `pathLength / (matrixMinutes × jitter)` per leg, and the sprite arrives when
 * the board says the driver frees up — give or take the jitter, which is the
 * point of the jitter.
 *
 * The `approachMin` in that recovery is *read off the trip*, not recomputed.
 * `trips.approach_min` is the very number the domain charged, which a second
 * `travelMinutes` call here is not obliged to agree with: it is zero for a bandera,
 * whose passenger is already aboard, and for a hail it was measured from the zone
 * the driver was in at assignment rather than from wherever they are now. Guessing
 * it instead put the bandera sprite three minutes behind the board on every
 * flagged-down fare — R3 quietly false in the one direction nothing on screen says.
 */

import type { TripRow } from "../../src/domain/trips";
import { travelMinutes } from "../../src/domain/places";
import type { Rng } from "./rng";
import type { Gazetteer, Pt } from "./town";
import { PX_PER_KM, fadeAt, pathLength, route, sampleAlong } from "./town";

/**
 * How far a trip may run from the matrix estimate, either way.
 *
 * Bounded at a quarter because this is what `learnZoneTime` folds back into the
 * matrix: enough spread that the cell visibly moves after a trip or two, little
 * enough that it stays a plausible afternoon in Copán. Unbounded noise would
 * teach the matrix nonsense on camera, and a demo whose travel times wander is
 * a demo that cannot claim the system learns.
 */
export const JITTER = 0.25;

/**
 * Deadheading pace, for the one drive the domain does not model: coming back.
 *
 * When a driver taps ✅ Listo the domain declares them available at the
 * destination that same instant — there is no "returning" state and there should
 * not be, since the next hail may well be out there. But a taxi that just drove
 * to the border cannot be drawn standing in the middle of town, so the sprite
 * covers the gap at its own pace, empty and therefore a little faster than the
 * matrix. The disagreement is brief, visible, and in the sprite's direction:
 * the board is right and the drawing is catching up.
 */
const DEADHEAD_KMH = 22;
const MIN_REPOSITION_MS = 6_000;

export type LegKind = "approach" | "carry" | "reposition";

type Leg = {
  kind: LegKind;
  path: Pt[];
  length: number;
  startAt: number;
  endAt: number;
  announced: boolean;
};

/** One driver's current drive, with the arithmetic that produced it. */
export type Plan = {
  kind: "trip" | "reposition";
  tripId: number | null;
  /** Minutes the matrix gives for current position → pickup. */
  approachMin: number;
  /** Minutes the matrix gives for pickup → destination. */
  legMin: number;
  jitter: number;
  /** The instant `markDriverUnderway` counted from. */
  origin: number;
  legs: Leg[];
  destLabel: string | null;
};

/** A drive, as the verification harness and the ticker want to read it. */
export type PlanInfo = {
  plan: Plan;
  driverId: number;
  phone: string;
  name: string;
  tuktuk: string | null;
};

export type TaxiView = {
  driverId: number;
  phone: string;
  name: string;
  tuktuk: string | null;
  status: string;
  zoneId: string | null;
  at: Pt;
  /** 1 facing east, -1 facing west. A tuktuk glyph reads badly rotated. */
  face: 1 | -1;
  opacity: number;
  leg: LegKind | null;
  /** The path still being driven, drawn as the ghost trail. */
  trail: { path: Pt[]; kind: LegKind } | null;
  destLabel: string | null;
};

export type WaitView = {
  tripId: number;
  at: Pt;
  state: string;
  who: string;
  destLabel: string | null;
};

export type FleetFrame = { taxis: TaxiView[]; waiting: WaitView[] };

/** A leg the sprite has finished. Phase 5's NPCs react to these. */
export type LegDone = {
  driverId: number;
  phone: string;
  tripId: number | null;
  leg: LegKind;
  /** Sim time the leg was scheduled to end, not the frame that noticed. */
  at: number;
  plan: Plan;
};

type Taxi = {
  driverId: number;
  phone: string;
  name: string;
  tuktuk: string | null;
  status: string;
  zoneId: string | null;
  availableAt: number;
  at: Pt;
  face: 1 | -1;
  plan: Plan | null;
};

/**
 * The columns `TripRow` declares, spelled out rather than `SELECT *`.
 *
 * A `SELECT *` here would compile and then hand back rows with two columns the
 * type says nothing about, so a later reader would reach for `picked_up_at`
 * believing it was typed.
 */
const TRIP_COLS = `id, source, customer_phone, pickup_lat, pickup_lng, pickup_zone_id,
  pickup_label, dest_zone_id, dest_landmark_id, dest_label, driver_id, state,
  quoted_wait_min, approach_min, requested_at, assigned_at, done_at`;

type DriverRowLite = {
  id: number;
  phone: string;
  name: string;
  tuktuk_no: string | null;
  status: string;
  zone_id: string | null;
  available_at: number;
};

export class Fleet {
  private readonly taxis = new Map<number, Taxi>();
  private waiting: WaitView[] = [];
  private readonly legListeners = new Set<(done: LegDone) => void>();
  private readonly planListeners = new Set<(info: PlanInfo) => void>();

  constructor(
    private readonly db: D1Database,
    private readonly town: Gazetteer,
    private readonly rng: Rng,
  ) {}

  /** Fires once per leg per drive, when the leg's scheduled end passes. */
  onLegComplete(fn: (done: LegDone) => void): () => void {
    this.legListeners.add(fn);
    return () => this.legListeners.delete(fn);
  }

  /** Fires when a drive is planned, with the numbers R3 is judged on. */
  onPlan(fn: (info: PlanInfo) => void): () => void {
    this.planListeners.add(fn);
    return () => this.planListeners.delete(fn);
  }

  planFor(driverId: number): Plan | null {
    return this.taxis.get(driverId)?.plan ?? null;
  }

  /**
   * Re-read the fleet and start, stop or retarget drives to match.
   *
   * Called after a drain rather than every frame, because `handleInbound` and
   * the sweep are the only things that can change a driver or a trip. The whole
   * method is a diff, deliberately: the map must survive state it did not
   * initiate — a trip the office cancels, a driver who taps ✅ Listo while their
   * sprite is still two blocks out — and a diff against the current rows
   * recovers from all of it without enumerating the cases.
   */
  async sync(now: number): Promise<void> {
    const drivers = await read<DriverRowLite>(
      this.db,
      `SELECT id, phone, name, tuktuk_no, status, zone_id, available_at
         FROM drivers WHERE active = 1 ORDER BY id`,
    );

    // Oldest open trip per driver, which is the one `activeTripForDriver`
    // returns and therefore the one a ✅ Listo will close.
    const open = new Map<number, TripRow>();
    for (const trip of await read<TripRow>(
      this.db,
      `SELECT ${TRIP_COLS} FROM trips
        WHERE state IN ('assigned','on_trip') AND driver_id IS NOT NULL
        ORDER BY requested_at DESC`,
    )) {
      open.set(trip.driver_id!, trip);
    }

    const live = new Set<number>();
    for (const row of drivers) {
      live.add(row.id);
      const taxi = this.upsert(row);
      this.place(taxi, now);
      await this.retarget(taxi, open.get(row.id) ?? null, now);
    }

    // A driver deactivated mid-demo simply stops being drawn; leaving the sprite
    // behind would show a taxi that dispatch can no longer reach.
    for (const id of [...this.taxis.keys()]) if (!live.has(id)) this.taxis.delete(id);

    this.waiting = (
      await read<TripRow>(
        this.db,
        `SELECT ${TRIP_COLS} FROM trips
          WHERE state IN ('pending','assigned') AND customer_phone IS NOT NULL
          ORDER BY requested_at`,
      )
    ).map((trip) => ({
      tripId: trip.id,
      at: this.pickupPoint(trip),
      state: trip.state,
      who: trip.customer_phone ?? "",
      destLabel: trip.dest_label,
    }));
  }

  /** Positions at `now`. Pure, cheap, and safe to call every frame. */
  sample(now: number): FleetFrame {
    const done: LegDone[] = [];
    const taxis: TaxiView[] = [];
    /**
     * Trips whose passenger is already in the tuktuk.
     *
     * A hail stays `assigned` from the moment it is claimed until ✅ Listo —
     * `markDriverUnderway` says why it must, and the driver's interface has no
     * "picked up" button to change it — so the database cannot say whether the
     * customer is still standing on the corner. The approach leg ending is the
     * map's own answer to that, and it is the same instant the sprite reaches
     * the pin, so the figure disappears exactly when the taxi arrives for them.
     */
    const aboard = new Set<number>();

    for (const taxi of this.taxis.values()) {
      const { leg, trail } = this.place(taxi, now);

      // Announced off the clock rather than on arriving within some radius: at
      // 12× a short leg can begin and end inside one frame, and a leg that never
      // announces is a driver who never taps ✅ Listo.
      for (const candidate of taxi.plan?.legs ?? []) {
        if (now < candidate.endAt) break;
        if (candidate.announced) continue;
        candidate.announced = true;
        done.push({
          driverId: taxi.driverId,
          phone: taxi.phone,
          tripId: taxi.plan?.tripId ?? null,
          leg: candidate.kind,
          at: candidate.endAt,
          plan: taxi.plan!,
        });
      }

      const plan = taxi.plan;
      if (plan?.kind === "trip" && plan.tripId !== null && leg !== "approach") {
        aboard.add(plan.tripId);
      }

      taxis.push({
        driverId: taxi.driverId,
        phone: taxi.phone,
        name: taxi.name,
        tuktuk: taxi.tuktuk,
        status: taxi.status,
        zoneId: taxi.zoneId,
        at: taxi.at,
        face: taxi.face,
        opacity: fadeAt(taxi.at),
        leg,
        trail,
        destLabel: taxi.plan?.destLabel ?? null,
      });
    }

    for (const event of done) for (const fn of [...this.legListeners]) fn(event);

    return { taxis, waiting: this.waiting.filter((w) => !aboard.has(w.tripId)) };
  }

  /**
   * Put a taxi's sprite where its plan says it is at `now`.
   *
   * Position is a pure function of the sim instant and the plan, so this is
   * cheap enough to run on every frame and safe to run twice. `sync` runs it
   * first thing, because a diff that retargets a driver has to start the new
   * path from where the sprite actually is — reading a stale position there
   * would send a cancelled taxi back from a corner it had already left.
   */
  private place(
    taxi: Taxi,
    now: number,
  ): { leg: LegKind | null; trail: { path: Pt[]; kind: LegKind } | null } {
    for (const candidate of taxi.plan?.legs ?? []) {
      if (now >= candidate.endAt) {
        taxi.at = candidate.path[candidate.path.length - 1]!;
        continue;
      }
      const span = candidate.endAt - candidate.startAt;
      const travelled = span <= 0 ? 1 : (now - candidate.startAt) / span;
      const spot = sampleAlong(candidate.path, candidate.length * clamp01(travelled));
      taxi.at = spot.at;
      // Only a decisively sideways heading flips the sprite; a road within a few
      // degrees of vertical would otherwise make it flap.
      if (Math.abs(spot.dx) > 0.2) taxi.face = spot.dx < 0 ? -1 : 1;
      return { leg: candidate.kind, trail: { path: candidate.path, kind: candidate.kind } };
    }
    return { leg: null, trail: null };
  }

  // ── Diffing ───────────────────────────────────────────────────────────────

  private upsert(row: DriverRowLite): Taxi {
    const existing = this.taxis.get(row.id);
    if (existing) {
      existing.status = row.status;
      existing.zoneId = row.zone_id;
      existing.availableAt = row.available_at;
      existing.name = row.name;
      existing.tuktuk = row.tuktuk_no;
      return existing;
    }

    const fresh: Taxi = {
      driverId: row.id,
      phone: row.phone,
      name: row.name,
      tuktuk: row.tuktuk_no,
      status: row.status,
      zoneId: row.zone_id,
      availableAt: row.available_at,
      at: this.parkingSpot(row.id, row.zone_id),
      face: 1,
      plan: null,
    };
    this.taxis.set(row.id, fresh);
    return fresh;
  }

  private async retarget(taxi: Taxi, trip: TripRow | null, now: number): Promise<void> {
    if (trip) {
      // A bandera trip is `on_trip` with no destination between the ✋ tap and
      // the driver picking a zone off the menu. `travelMinutes(zone, null)`
      // answers 10 for that, which would schedule a drive to nowhere and land
      // the sprite there instantly. Wait for the destination instead.
      if (!trip.dest_zone_id) return;
      if (taxi.plan?.kind === "trip" && taxi.plan.tripId === trip.id) return;
      taxi.plan = await this.planTrip(taxi, trip, now);
      this.announcePlan(taxi);
      return;
    }

    if (taxi.plan?.kind === "trip") taxi.plan = null;
    if (taxi.plan && now < taxi.plan.legs[taxi.plan.legs.length - 1]!.endAt) return;

    const target = this.parkingSpot(taxi.driverId, taxi.zoneId, taxi.at);
    if (Math.hypot(target.x - taxi.at.x, target.y - taxi.at.y) < 2) {
      taxi.plan = null;
      return;
    }
    taxi.plan = this.planReposition(taxi, target, now);
    this.announcePlan(taxi);
  }

  private async planTrip(taxi: Taxi, trip: TripRow, now: number): Promise<Plan> {
    // The approach the domain actually charged. Recomputing it is only a fallback
    // for a row `markDriverUnderway` never reached — which should not happen for an
    // assigned trip, and if it does, the drive is worth drawing at the length the
    // board's own arithmetic implies rather than refusing to draw it.
    const approachMin =
      trip.approach_min ?? (await travelMinutes(this.db, taxi.zoneId, trip.pickup_zone_id));
    // Still read fresh, because `learnZoneTime` moves this cell as the hour goes on
    // and the sprite should run at the matrix's current opinion. The plan is built
    // once per trip and never rebuilt for the same `tripId`, so what it captures is
    // the matrix as it stood when the driver was given the job — the same instant
    // `markDriverUnderway` read it.
    const legMin = await travelMinutes(this.db, trip.pickup_zone_id, trip.dest_zone_id);
    const plannedMs = (approachMin + legMin) * 60_000;

    // Recovered, not observed. Clamped between the assignment and now because a
    // projection from before the trip existed, or from the future, could only
    // come from a row `markDriverUnderway` never touched — and that is a bug
    // worth drawing plainly rather than amplifying into a sprite that teleports.
    const origin = Math.min(Math.max(taxi.availableAt - plannedMs, trip.assigned_at ?? now), now);
    const jitter = 1 + (this.rng.next() * 2 - 1) * JITTER;

    const pickupAt = this.pickupPoint(trip);
    const destAt = this.destPoint(trip) ?? pickupAt;
    const bandera = trip.source === "bandera";

    const legs: Leg[] = [];
    let start = origin;
    // A flagged-down passenger is already aboard, so there is no approach to
    // drive and the domain charges none. Skipped on `source` rather than on
    // `approachMin === 0` because `pushLeg` floors a leg at two sim-seconds: a
    // zero-length approach would still teleport the sprite to the zone's rank and
    // announce an `approach` leg complete, which is a hand-off the NPC drivers read.
    if (!bandera) {
      start = pushLeg(legs, "approach", route(taxi.at, pickupAt), start, approachMin * jitter);
    }
    pushLeg(legs, "carry", route(pickupAt, destAt), start, legMin * jitter);

    return {
      kind: "trip",
      tripId: trip.id,
      approachMin,
      legMin,
      jitter,
      origin,
      legs,
      destLabel: trip.dest_label ?? this.town.zoneName(trip.dest_zone_id ?? "") ?? null,
    };
  }

  private planReposition(taxi: Taxi, target: Pt, now: number): Plan {
    const path = route(taxi.at, target);
    const km = pathLength(path) / PX_PER_KM;
    const minutes = Math.max(MIN_REPOSITION_MS / 60_000, (km / DEADHEAD_KMH) * 60);
    const legs: Leg[] = [];
    pushLeg(legs, "reposition", path, now, minutes);
    return {
      kind: "reposition",
      tripId: null,
      approachMin: 0,
      legMin: 0,
      jitter: 1,
      origin: now,
      legs,
      destLabel: null,
    };
  }

  private announcePlan(taxi: Taxi): void {
    if (!taxi.plan) return;
    const info: PlanInfo = {
      plan: taxi.plan,
      driverId: taxi.driverId,
      phone: taxi.phone,
      name: taxi.name,
      tuktuk: taxi.tuktuk,
    };
    for (const fn of [...this.planListeners]) fn(info);
  }

  // ── Places ────────────────────────────────────────────────────────────────

  /**
   * Where a trip is picked up: the customer's exact pin when there is one, and
   * the zone's parking spot otherwise — a bandera has no pin because the
   * passenger is already in the tuktuk.
   */
  private pickupPoint(trip: TripRow): Pt {
    if (trip.pickup_lat !== null && trip.pickup_lng !== null) {
      return this.town.pointForCoords({ lat: trip.pickup_lat, lng: trip.pickup_lng });
    }
    return this.town.pointForZone(trip.pickup_zone_id ?? "") ?? this.town.pointForNode("parque_central");
  }

  /**
   * Where a trip ends.
   *
   * A landmark beats the zone: the customer chose the Museo, not "Las Ruinas",
   * and the driver was sent the landmark's name. For a place off the frame the
   * gateway's vanishing point is used rather than its gate, so the taxi drives
   * out of town instead of parking on the border.
   */
  private destPoint(trip: TripRow): Pt | null {
    if (trip.dest_landmark_id) {
      const node = this.town.nodeForLandmark(trip.dest_landmark_id);
      if (node) return this.town.vanishingPoint(node) ?? this.town.pointForNode(node);
    }
    return this.town.pointForZone(trip.dest_zone_id ?? "");
  }

  /**
   * Where this driver parks when they have nothing to do.
   *
   * The slot comes from the driver's id and not from the PRNG: a sprite that
   * moved to a different corner of the rank each time a plan was made would read
   * as a bug, and spending PRNG draws on decoration would shift the jitter
   * sequence and make the hour unreproducible (R4).
   */
  private parkingSpot(driverId: number, zoneId: string | null, near?: Pt): Pt {
    return (
      this.town.parkingSpot(zoneId, driverId, near) ?? this.town.pointForNode("parque_central")
    );
  }
}

function pushLeg(legs: Leg[], kind: LegKind, path: Pt[], startAt: number, minutes: number): number {
  // Floored at a couple of sim-seconds rather than at zero: a leg with no
  // duration is one the sampler can never be inside, so it would announce
  // itself complete on the same frame it started.
  const endAt = startAt + Math.max(0.03, minutes) * 60_000;
  legs.push({ kind, path, length: pathLength(path), startAt, endAt, announced: false });
  return endAt;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A demo-only read.
 *
 * Through the shim rather than through the `sqlite` handle it exposes, for the
 * reason `phone.ts` gives: the shim caches prepared statements by SQL text, so
 * these three queries are three sql.js statements for the whole hour instead
 * of a WASM-side allocation per sync. It is also the narrower privilege — the raw
 * handle can write, and a write from this file would invert R2.
 */
async function read<T>(db: D1Database, sql: string): Promise<T[]> {
  const { results } = await db.prepare(sql).all<T>();
  return results;
}
