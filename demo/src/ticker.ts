/**
 * The event ticker: why what just happened, happened.
 *
 * Four phones and a map show the *what*. A viewer watching a taxi turn around
 * still has to be told that a driver two hundred pixels away tapped ✅ Listo and
 * that the trip which had been sitting in the list for six minutes is the reason.
 * That is this file's whole job, and it is why the lines name the driver, the
 * customer, the destination and the quoted minutes rather than summarising.
 *
 * Every line is derived, not reported (R2). There is no bookkeeping of what the
 * demo *thinks* it did — no "I pushed a ✅ Listo so I will write that down". The
 * sources are the database, diffed the way `fleet.ts` diffs it, and the two
 * traffic logs:
 *
 *   `trips`          a row appearing, or its state changing, is a hail, an
 *                    assignment, a cancellation or a completed ride
 *   `status_events`  the domain's own audit log of breaks and returns — written by
 *                    `logStatus`, so a break the demo never saw still shows up
 *   `transport.sent` the refusals, which are the one interesting class of event
 *                    that changes no row: `finishTripFirst` and `noMatch` exist
 *                    only as a message, and a ticker reading rows alone would show
 *                    a driver tapping ☕ Descanso and nothing happening
 *   `queue.delivered` a driver's opening location, which has no other trace worth
 *                    a line
 *
 * `note()` is the seam for facts the domain cannot know: who has taken control of
 * a phone, a customer who could not be given a slot, and — Phase 5 — the scripted
 * beats and the zone-time line.
 */

import { copy } from "../../src/domain/copy";
import { formatSimTime, MINUTE_MS } from "./clock";
import type { Fleet } from "./fleet";
import { formatBody } from "./phone";
import type { InboundQueue } from "./queue";
import type { Names } from "./slots";
import type { DemoTransport } from "./transport";

export type TickKind =
  | "hail"
  | "queued"
  | "assign"
  | "bandera"
  | "done"
  | "cancel"
  | "break"
  | "refuse"
  | "control"
  | "beat";

/**
 * How many lines are kept.
 *
 * The ticker is a log, not a record: the scripted hour is thirty-odd beats, and a
 * page left running on a table all afternoon should not grow a DOM node per
 * message until it stutters.
 */
const MAX_LINES = 240;

export type TickerDeps = {
  db: D1Database;
  queue: InboundQueue;
  transport: DemoTransport;
  /**
   * Read only to answer one question the database cannot: had the sprite arrived
   * yet? The early-✅ Listo wrinkle in §8 is a disagreement between the board and
   * the drawing, so the drawing is the only place the fact lives.
   */
  fleet: Fleet;
  names: Names;
  list: HTMLElement;
};

type DriverFacts = { id: number; phone: string; name: string; tuktuk: string | null; zone: string | null };

type TripRow = {
  id: number;
  source: string;
  customer_phone: string | null;
  pickup_zone_id: string | null;
  pickup_label: string | null;
  dest_zone_id: string | null;
  dest_label: string | null;
  driver_id: number | null;
  state: string;
  quoted_wait_min: number | null;
  requested_at: number;
  assigned_at: number | null;
  done_at: number | null;
  canceled_reason: string | null;
};

/** The last thing this ticker saw about a trip. A diff cursor, not a belief. */
type TripSeen = { state: string; dest: string | null };

type Line = { at: number; kind: TickKind; text: string };

export class Ticker {
  private readonly seenTrips = new Map<number, TripSeen>();
  private readonly greeted = new Set<number>();
  private drivers = new Map<number, DriverFacts>();
  private byPhone = new Map<string, DriverFacts>();
  private zones = new Map<string, string>();
  private lastStatusEvent = 0;
  private inbound = 0;
  private outbound = 0;
  private lines = 0;
  private readonly empty: HTMLElement;

  constructor(private readonly deps: TickerDeps) {
    this.empty = document.createElement("li");
    this.empty.className = "tick tick--empty";
    this.empty.textContent = "Todavía no ha pasado nada. Pulse 🎬 Empezar la hora.";
    this.deps.list.append(this.empty);
  }

  /**
   * Append one line the domain could not have told us.
   *
   * Phase 5's scenario beats and the zone-time strip come in here; so do the
   * take-control changes and the slot refusals, which are facts about the demo
   * rather than about the town.
   */
  note(at: number, kind: TickKind, text: string): void {
    this.write({ at, kind, text });
  }

  /**
   * The two lines that close the hour.
   *
   * Counted out of the tables at the moment the clock stops, not accumulated as the
   * morning went along (R2). That is the difference between a summary and a tally: a
   * counter the demo kept would be the one figure on this page capable of disagreeing
   * with the town, and it is the last thing anybody reads — the number they will
   * repeat afterwards. `zone_times.samples > 0` is the honest test for a corrected
   * cell, because every hand-seeded row starts at zero.
   */
  async closing(at: number): Promise<void> {
    const tally = await this.deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM trips WHERE state = 'done') AS closed,
           (SELECT COUNT(*) FROM trips WHERE state = 'done' AND source = 'bandera') AS bandera,
           (SELECT COUNT(*) FROM trips WHERE state = 'canceled') AS canceled,
           (SELECT COUNT(*) FROM status_events WHERE status = 'break') AS breaks,
           (SELECT COUNT(*) FROM zone_times WHERE samples > 0) AS cells`,
      )
      .first<{
        closed: number;
        bandera: number;
        canceled: number;
        breaks: number;
        cells: number;
      }>();
    if (!tally) return;

    // Built from clauses rather than from one template, because every count can be
    // zero — a viewer who took the phones over may leave no cancellation at all —
    // and "0 solicitudes canceladas" in a closing summary reads as a system
    // reporting on itself rather than as somebody telling you what happened.
    const parts = [count(tally.closed, "viaje cerrado", "viajes cerrados")];
    if (tally.bandera > 0) {
      parts.push(tally.bandera === 1 ? "uno de ellos de bandera" : `${tally.bandera} de bandera`);
    }
    if (tally.canceled > 0) {
      parts.push(count(tally.canceled, "solicitud cancelada", "solicitudes canceladas"));
    }
    if (tally.breaks > 0) parts.push(count(tally.breaks, "descanso", "descansos"));
    if (tally.cells > 0) {
      parts.push(count(tally.cells, "casilla de la matriz corregida", "casillas de la matriz corregidas"));
    }

    this.write({
      at,
      kind: "beat",
      text: `Terminó la hora: ${join(parts)}.`,
    });
    this.write({
      at,
      kind: "beat",
      text:
        "El reloj queda detenido aquí y los tuktuks con él. Pulse ↻ Repetir la hora " +
        "para correr la misma hora otra vez, igual que esta.",
    });
  }

  /**
   * Clear the log.
   *
   * Phase 5's "run the hour again" control rebuilds the world against a fresh
   * database; the last run's lines left above this one's would read as one long
   * morning in which everything happened twice.
   */
  dispose(): void {
    // Emptied rather than reset to the placeholder, because the ticker that
    // replaces this one appends its own: leaving the old placeholder behind would
    // put "nothing has happened yet" above the new run's first line, which is both
    // wrong and the one thing that makes the log stop reading chronologically.
    this.deps.list.replaceChildren();
    this.lines = 0;
  }

  /**
   * One pass, after a drain.
   *
   * Must run *before* `fleet.sync()`: a trip that just closed is still on the
   * fleet's plan at this point, and that plan is the only witness to whether the
   * sprite had arrived. After the sync the drive is gone and the ✅-Listo-early
   * line can no longer be written.
   */
  async observe(now: number): Promise<void> {
    await this.loadCast();

    const lines: Line[] = [];
    this.readInbound(lines);
    await this.readTrips(lines, now);
    await this.readStatusEvents(lines);
    this.readOutbound(lines);

    // Stable sort by sim time: a pass can contain a cause and its effects, and
    // within one drain they carry the timestamps the domain gave them rather than
    // the order the four readers above happen to run in.
    lines.sort((a, b) => a.at - b.at);
    for (const line of lines) this.write(line);
  }

  // ── The cast ──────────────────────────────────────────────────────────────

  private async loadCast(): Promise<void> {
    const { results } = await this.deps.db
      .prepare("SELECT id, phone, name, tuktuk_no, zone_id FROM drivers")
      .all<{ id: number; phone: string; name: string; tuktuk_no: string | null; zone_id: string | null }>();

    this.drivers = new Map();
    this.byPhone = new Map();
    for (const row of results) {
      const facts: DriverFacts = {
        id: row.id,
        phone: row.phone,
        name: row.name,
        tuktuk: row.tuktuk_no,
        zone: row.zone_id,
      };
      this.drivers.set(row.id, facts);
      this.byPhone.set(row.phone, facts);
    }

    if (this.zones.size > 0) return;
    const zones = await this.deps.db.prepare("SELECT id, name FROM zones").all<{ id: string; name: string }>();
    for (const zone of zones.results) this.zones.set(zone.id, zone.name);
  }

  // ── Trips ─────────────────────────────────────────────────────────────────

  private async readTrips(lines: Line[], now: number): Promise<void> {
    const { results } = await this.deps.db
      .prepare(
        `SELECT id, source, customer_phone, pickup_zone_id, pickup_label, dest_zone_id,
                dest_label, driver_id, state, quoted_wait_min, requested_at, assigned_at,
                done_at, canceled_reason
           FROM trips ORDER BY id`,
      )
      .all<TripRow>();

    for (const trip of results) {
      const seen = this.seenTrips.get(trip.id);
      this.seenTrips.set(trip.id, { state: trip.state, dest: trip.dest_label });

      if (!seen) {
        this.openingLine(lines, trip);
        if (trip.state === "assigned") this.assignedLine(lines, trip, false);
        continue;
      }

      if (seen.state === trip.state) {
        // A bandera has no destination between the ✋ tap and the driver picking a
        // zone, and it never changes state in between either — so this is the only
        // place the second half of that beat can be noticed.
        if (trip.source === "bandera" && !seen.dest && trip.dest_label) {
          lines.push({
            at: trip.assigned_at ?? trip.requested_at,
            kind: "bandera",
            text: `${this.who(trip.driver_id)} lleva el pasajero a ${trip.dest_label}.`,
          });
        }
        continue;
      }

      if (trip.state === "assigned") this.assignedLine(lines, trip, seen.state === "pending");
      if (trip.state === "done") this.doneLine(lines, trip, now);
      if (trip.state === "canceled") this.canceledLine(lines, trip, now);
    }
  }

  private openingLine(lines: Line[], trip: TripRow): void {
    if (trip.source === "bandera") {
      lines.push({
        at: trip.requested_at,
        kind: "bandera",
        text: `${this.who(trip.driver_id)} recogió un pasajero en la calle ✋.`,
      });
      return;
    }

    const from = trip.pickup_label ?? this.zone(trip.pickup_zone_id);
    lines.push({
      at: trip.requested_at,
      kind: "hail",
      text: `${this.customer(trip)} pidió un tuktuk desde ${from} → ${trip.dest_label ?? "—"}.`,
    });

    if (trip.state !== "pending") return;
    // No number here on purpose. The quote a queued customer reads comes out of
    // `quoteWaitMinutes` and is never written to the row — `quoted_wait_min` is
    // filled in only when the trip is assigned on the spot — so the minutes live
    // on the customer's own phone and inventing them here would be the one kind of
    // lie this file exists to avoid.
    // Phrased without an adjective that has to agree: the demo's customers are
    // named by whoever writes the scenario, and "queda anotada" about a Beto is the
    // kind of mistake that makes a Spanish-speaking audience stop trusting the rest
    // of the Spanish on the page.
    lines.push({
      at: trip.requested_at,
      kind: "queued",
      text: `Ningún tuktuk libre: ${this.customer(trip)} queda en la lista.`,
    });
  }

  private assignedLine(lines: Line[], trip: TripRow, wasQueued: boolean): void {
    const at = trip.assigned_at ?? trip.requested_at;
    const eta = trip.quoted_wait_min === null ? "" : ` · ${trip.quoted_wait_min} min`;

    if (!wasQueued) {
      lines.push({ at, kind: "assign", text: `Asignado: ${this.who(trip.driver_id)}${eta}.` });
      return;
    }

    // The beat the whole demo is built around: a trip that was in the list gets a
    // driver the moment one frees up, and the customer hears about it minutes
    // after they had stopped expecting to.
    const waited = Math.round((at - trip.requested_at) / MINUTE_MS);
    lines.push({
      at,
      kind: "assign",
      text:
        `Se desocupó ${this.who(trip.driver_id)} y va por ${this.customer(trip)}` +
        `${waited > 0 ? `, que esperó ${waited} min` : ""}.`,
    });
  }

  private doneLine(lines: Line[], trip: TripRow, now: number): void {
    const at = trip.done_at ?? now;
    const where = trip.dest_label ?? this.zone(trip.dest_zone_id);
    lines.push({
      at,
      kind: "done",
      text: `${this.who(trip.driver_id)} cerró el viaje a ${where} con ✅ Listo.`,
    });

    // §8's deliberate wrinkle, said out loud. The domain takes ✅ Listo to mean "I
    // am at the destination" — that is the entire position-tracking system — so a
    // driver who taps early really is recorded as having arrived, and the sprite
    // is the thing that is now wrong. Hiding it would misrepresent the design.
    const plan = trip.driver_id === null ? null : this.deps.fleet.planFor(trip.driver_id);
    const last = plan?.legs[plan.legs.length - 1];
    if (!plan || plan.tripId !== trip.id || !last || last.endAt <= at) return;
    lines.push({
      at,
      kind: "beat",
      text:
        `…y lo tocó antes de llegar: le faltaban ${((last.endAt - at) / MINUTE_MS).toFixed(1)} min ` +
        `de camino. El sistema ya lo da por ${where}; el tuktuk termina el trayecto en el mapa.`,
    });
  }

  private canceledLine(lines: Line[], trip: TripRow, now: number): void {
    // Falls back to the current instant and not to `requested_at`: the log is
    // appended in the order it is read, so a line stamped minutes in the past would
    // sit under a newer one and the timestamps would stop running downwards.
    // `cancelTrip` always writes `done_at`, so this is a guard, not a case.
    const at = trip.done_at ?? now;
    lines.push({
      at,
      kind: "cancel",
      text:
        trip.canceled_reason === "customer"
          ? `${this.customer(trip)} escribió *cancelar*: su solicitud queda anulada.`
          : `Se anuló la solicitud de ${this.customer(trip)} (${trip.canceled_reason ?? "sin motivo"}).`,
    });
  }

  // ── The domain's own audit log ─────────────────────────────────────────────

  private async readStatusEvents(lines: Line[]): Promise<void> {
    const { results } = await this.deps.db
      .prepare("SELECT id, driver_id, status, at FROM status_events WHERE id > ? ORDER BY id")
      .bind(this.lastStatusEvent)
      .all<{ id: number; driver_id: number; status: string; at: number }>();

    for (const row of results) {
      this.lastStatusEvent = Math.max(this.lastStatusEvent, row.id);
      const who = this.who(row.driver_id);
      if (row.status === "break") {
        lines.push({ at: row.at, kind: "break", text: `${who} se fue a descansar ☕.` });
      } else if (row.status === "available") {
        lines.push({ at: row.at, kind: "break", text: `${who} volvió al servicio 🛺.` });
      } else if (row.status === "nudged") {
        lines.push({
          at: row.at,
          kind: "refuse",
          text: `La oficina le preguntó a ${who} si ya terminó el viaje.`,
        });
      }
    }
  }

  // ── Traffic ───────────────────────────────────────────────────────────────

  /** A driver's location pin, which is how a shift starts and leaves no other trace. */
  private readInbound(lines: Line[]): void {
    const { delivered } = this.deps.queue;
    for (; this.inbound < delivered.length; this.inbound += 1) {
      const { event } = delivered[this.inbound]!;
      if (event.payload.kind !== "location") continue;
      const driver = this.byPhone.get(event.from);
      if (!driver) continue;

      const first = !this.greeted.has(driver.id);
      this.greeted.add(driver.id);
      lines.push({
        at: event.at,
        kind: "break",
        text: first
          ? `${this.who(driver.id)} entró en turno y mandó su ubicación 📍: está por ${this.zone(driver.zone)}.`
          : `${this.who(driver.id)} mandó su ubicación 📍: está por ${this.zone(driver.zone)}.`,
      });
    }
  }

  /**
   * The messages that are the only evidence of themselves.
   *
   * Compared against `copy.ts`'s own constants rather than against a copy of the
   * wording, so a staff member rewording a refusal in the app reworders the thing
   * this matches on at the same time. The templates — anything built from a name or
   * a number — are deliberately not matched here; those have rows behind them.
   */
  private readOutbound(lines: Line[]): void {
    const { sent } = this.deps.transport;
    for (; this.outbound < sent.length; this.outbound += 1) {
      const record = sent[this.outbound]!;
      const spec = record.message.spec;
      const at = record.at;
      const driver = this.byPhone.get(record.to);

      if (spec.kind === "text" && spec.body === copy.driver.finishTripFirst) {
        lines.push({
          at,
          kind: "refuse",
          text:
            `${this.who(driver?.id ?? null)} pidió descanso con un viaje abierto: ` +
            `el sistema se lo negó hasta cerrarlo.`,
        });
      } else if (spec.kind === "text" && spec.body === copy.driver.noActiveTrip) {
        lines.push({
          at,
          kind: "refuse",
          text: `${this.who(driver?.id ?? null)} tocó ✅ Listo sin ningún viaje abierto.`,
        });
      } else if (spec.kind === "text" && spec.body === copy.customer.noMatch) {
        lines.push({
          at,
          kind: "refuse",
          text: `${this.deps.names.of(record.to)} escribió un lugar que no está en la lista.`,
        });
      } else if (spec.kind === "list" && spec.body === copy.customer.confirmMatch) {
        lines.push({
          at,
          kind: "hail",
          text: `${this.deps.names.of(record.to)} escribió el destino a mano; se le ofrecieron los parecidos.`,
        });
      }
    }
  }

  // ── Words ─────────────────────────────────────────────────────────────────

  private who(driverId: number | null): string {
    if (driverId === null) return "Un conductor";
    const driver = this.drivers.get(driverId);
    if (!driver) return "Un conductor";
    return driver.tuktuk ? `${driver.name} (#${driver.tuktuk})` : driver.name;
  }

  private customer(trip: TripRow): string {
    return trip.customer_phone ? this.deps.names.of(trip.customer_phone) : "El pasajero";
  }

  private zone(zoneId: string | null): string {
    return (zoneId && this.zones.get(zoneId)) || "—";
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private write(line: Line): void {
    this.empty.remove();

    const item = document.createElement("li");
    item.className = "tick";
    item.dataset.kind = line.kind;

    const stamp = document.createElement("time");
    stamp.className = "tick__time";
    stamp.textContent = formatSimTime(line.at);

    const text = document.createElement("span");
    text.className = "tick__text";
    text.append(formatBody(line.text));

    item.append(stamp, text);
    this.deps.list.append(item);
    this.lines += 1;

    while (this.lines > MAX_LINES && this.deps.list.firstElementChild) {
      this.deps.list.firstElementChild.remove();
      this.lines -= 1;
    }

    // Newest at the bottom, like a log being printed. Pinned to the end rather
    // than left where the reader was, because the whole point is the latest line.
    this.deps.list.scrollTop = this.deps.list.scrollHeight;
  }
}

// ── Wording ─────────────────────────────────────────────────────────────────

/**
 * A count and its noun, agreeing.
 *
 * Spanish will not let a number be printed beside an invariant noun the way English
 * nearly does, and the closing summary is the one line on the page whose numbers
 * are not known until it is written — so the agreement has to be computed rather
 * than written out.
 */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A list in Spanish: commas, and "y" before the last. */
function join(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]!}`;
}
