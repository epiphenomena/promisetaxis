/**
 * Phase 1's proof: the real dispatch domain, unmodified, running on sql.js.
 *
 * This is not a unit test — the 49 tests in `test/` already cover the flows
 * against real D1. What this script proves is narrower and is the whole risk of
 * the demo: that `src/domain` cannot tell `demo/src/d1.ts` from the D1 binding.
 * So it drives a complete hail through `handleInbound` and prints every
 * `OutboundSpec` in order, for eyeballing against what the Worker produces.
 *
 * Run it with `npm run demo:verify`.
 *
 * Node is only the host. Nothing in `demo/src` imports node, and the same two
 * modules run in the browser in phase 2.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import initSqlJs from "sql.js";

import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { copy } from "../src/domain/copy";
import { claimDriver } from "../src/domain/dispatch";
import { createFlowContext, handleInbound } from "../src/domain/flow";
import { travelMinutes } from "../src/domain/places";
import { sweepStuckState } from "../src/domain/sweep";
import type { InboundPayload, OutboundMessage, OutboundSpec } from "../src/domain/types";
import { openDemoDb } from "./src/db";
import type { SqlJsD1Database } from "./src/d1";

/**
 * A fixed clock, so travel-time arithmetic is exact and the run is replayable
 * (R4). Landed on 09:00 UTC because the log then reads as the demo day in §10 of
 * the plan, and because it is comfortably wider than an int32 — epoch ms have to
 * survive the shim intact or every wait quote is wrong.
 */
const T0 = 1_699_952_400_000;
const MINUTE = 60_000;

const ANA = "50488880001";
const JOSE = "50499990001";
const MARVIN = "50499990002";
const ROSA = "50499990003";
const CHEPE = "50499990004";

const NAMES: Record<string, string> = {
  [ANA]: "Ana",
  [JOSE]: "Don José #3",
  [MARVIN]: "Marvin #7",
  [ROSA]: "Doña Rosa #11",
  [CHEPE]: "Chepe #15",
};

/**
 * The Estadio, in `barrio_abajo`. Chosen so the ranking is decided by distance
 * and not by a tie-break: approach is 5 / 8 / 9 minutes for José / Marvin /
 * Rosa, so the winner is unambiguous and an assertion on it means something.
 */
const AT_ESTADIO = { lat: 14.8365, lng: -89.1552 };

const transport = new MemoryTransport();
let db: SqlJsD1Database;
let messageSeq = 0;
let checks = 0;

async function main(): Promise<void> {
  const SQL = await initSqlJs({ wasmBinary: loadWasm() });
  db = openDemoDb(SQL);

  // ── The hail ───────────────────────────────────────────────────────────────
  // One FlowContext per delivered event with `now` advancing, which is how the
  // Worker's webhook handler does it (src/index.ts:47) and how phase 2's tick
  // loop will. Sharing one ctx across a conversation would freeze the clock.
  await beat(0, ANA, { kind: "text", text: "buenas, necesito un tuktuk" });
  expectSpec("greeting asks for a location", -1, {
    kind: "locationRequest",
    body: copy.customer.greeting,
  });

  await beat(1, ANA, { kind: "location", ...AT_ESTADIO });
  expect("zone menu offers all 7 seeded zones", rowIds(lastSpec()).length, 7);

  await beat(2, ANA, { kind: "list", id: "zone:ruinas", title: "Las Ruinas" });
  expect(
    "landmark menu is the Las Ruinas gazetteer plus the free-text escape",
    rowIds(lastSpec()).join(","),
    "lm:parque_arq,lm:museo,lm:macaw_mountain,lm:__other__",
  );

  await beat(3, ANA, { kind: "list", id: "lm:parque_arq", title: "Parque Arqueológico" });

  // ── The customer was quoted, and the driver got the job ────────────────────
  expectSpec("Ana is quoted the nearest idle driver", -3, {
    kind: "text",
    body: copy.customer.assigned("Don José", "3", 5),
  });
  expectSpec("José gets the trip with his three buttons", -2, {
    kind: "buttons",
    body: copy.driver.newTrip("Barrio abajo", "Parque Arqueológico"),
    buttons: [
      { id: "drv:done", title: copy.driver.buttons.done },
      { id: "drv:bandera", title: copy.driver.buttons.bandera },
      { id: "drv:break", title: copy.driver.buttons.break },
    ],
  });
  expectSpec("…and Ana's exact pin, not just her zone", -1, {
    kind: "location",
    lat: AT_ESTADIO.lat,
    lng: AT_ESTADIO.lng,
    name: copy.driver.pinCaption,
  });

  const trip = await row<{ id: number; state: string; driver_id: number; quoted_wait_min: number }>(
    "SELECT id, state, driver_id, quoted_wait_min FROM trips ORDER BY id DESC LIMIT 1",
  );
  expect("trip is assigned", trip.state, "assigned");
  expect("…to José", await driverName(trip.driver_id), "Don José");
  expect("…at the wait he was quoted", trip.quoted_wait_min, 5);

  // meta.last_row_id carried this id out of createHail; if it were 0 the whole
  // hand-off above would have been about a trip that does not exist.
  expect("createHail returned a real rowid", trip.id, 1);

  // Epoch milliseconds are wider than an int32, and every dispatch decision is
  // timestamp arithmetic — a lossy round-trip would surface much later as
  // inexplicable wait quotes.
  const logged = await row<{ at: number }>(
    "SELECT at FROM events WHERE direction = 'in' ORDER BY id LIMIT 1",
  );
  expect("epoch ms survive the round-trip intact", logged.at, T0);

  // ── ✅ Listo, seven minutes later ──────────────────────────────────────────
  const doneId = await beat(10, JOSE, { kind: "button", id: "drv:done", title: "✅ Listo" });

  expectSpec("José is told the trip closed", -3, { kind: "text", body: copy.driver.tripDone });
  expectSpec("Ana gets the thank-you", -2, { kind: "text", body: copy.customer.tripDone });
  expect("…addressed to Ana", nth(-2).to, ANA);
  expectSpec("…and José is offered the empty queue", -1, {
    kind: "buttons",
    body: copy.driver.idle,
    buttons: [
      { id: "drv:done", title: copy.driver.buttons.done },
      { id: "drv:bandera", title: copy.driver.buttons.bandera },
      { id: "drv:break", title: copy.driver.buttons.break },
    ],
  });

  const closed = await row<{ state: string; done_at: number }>(
    "SELECT state, done_at FROM trips WHERE id = ?",
    trip.id,
  );
  expect("trip is done", closed.state, "done");
  expect("…at the sim time of the tap", closed.done_at, T0 + 10 * MINUTE);

  // The position-inference mechanism at the heart of the design: José never sent
  // a location, and the system now knows he is at the ruins because that is
  // where the trip he just closed was going.
  const jose = await row<{ status: string; zone_id: string; projected_zone_id: string }>(
    "SELECT status, zone_id, projected_zone_id FROM drivers WHERE phone = ?",
    JOSE,
  );
  expect("José is inferred to be at his drop-off", jose.zone_id, "ruinas");
  expect("…with nothing projected beyond it", jose.projected_zone_id, "ruinas");
  expect("…and free again", jose.status, "available");

  // ── What the matrix learned, and from what ────────────────────────────────
  //
  // Asserted arithmetically rather than "it moved", because both halves of
  // `learnZoneTime` are corrections to bugs this demo found and each one is a
  // number somebody could get wrong again without any test noticing.
  //
  // This is also the check that says migration 0002 was applied at all. It is
  // worth having as an assertion instead of a crash: `markDriverUnderway` writes
  // `approach_min` on every trip, so a demo built against `0001` alone fails on
  // the first hail with `no such column`, which reads as a shim bug rather than
  // as the stale schema it is. `db.ts` explains why the list is enumerated.
  const taught = await row<{ approach_min: number; assigned_at: number; done_at: number }>(
    "SELECT approach_min, assigned_at, done_at FROM trips WHERE id = ?",
    trip.id,
  );
  expect("the approach was recorded on the trip that drove it", taught.approach_min, 5);
  expect(
    "…which is centro → barrio_abajo out of the matrix, not a number of its own",
    await travelMinutes(db, "centro", "barrio_abajo"),
    5,
  );

  const spanMin = (taught.done_at - taught.assigned_at) / MINUTE;
  expect("the trip spanned 7 minutes from assignment to ✅ Listo", spanMin, 7);

  // The cell being taught is barrio_abajo → ruinas, so the approach across town
  // to reach Ana is not part of it. Leaving it in is what drifted cells by up to
  // ×2.28 over a simulated day, because travelMinutes reads this same cell back
  // when it estimates the *next* approach.
  const observed = spanMin - taught.approach_min;
  expect("…of which the ride itself was 2, the approach having been subtracted", observed, 2);

  const learned = await row<{ minutes: number; samples: number }>(
    "SELECT minutes, samples FROM zone_times WHERE from_zone = 'barrio_abajo' AND to_zone = 'ruinas'",
  );
  // `weight = Math.max(1, Math.min(samples, 20))`: a hand-seeded row carries
  // samples = 0 and is blended as one observation, so the first real trip lands
  // exactly midway. Floored at 1 and not 0, which would have let one slow fare
  // behind a truck become the town's official travel time.
  expect("the seeded 9 was refined, not replaced", learned.minutes, (9 + observed) / 2);
  expect("…which is exactly halfway to the observed 2", learned.minutes, 5.5);
  expect("…and counts as one sample", learned.samples, 1);

  // ── meta.changes, end to end ───────────────────────────────────────────────
  // Replaying the ✅ Listo is the harm the unique index on events.message_id
  // exists to prevent: if the gate leaked, onDone would run again, find no
  // active trip, and tell José so. Silence is the correct behaviour.
  const sentBefore = transport.sent.length;
  const eventsBefore = await count("SELECT count(*) AS n FROM events");
  await beat(11, JOSE, { kind: "button", id: "drv:done", title: "✅ Listo" }, doneId);
  expect("a replayed messageId sends nothing", transport.sent.length, sentBefore);
  expect("…and logs nothing", await count("SELECT count(*) AS n FROM events"), eventsBefore);

  // The other half of the same mechanism: the conditional UPDATE in claimDriver
  // matches no row, so `meta.changes` is 0 and the caller moves on. Chepe is
  // registered and active but still `off`, because nothing has arrived from his
  // number — first contact is what starts a shift (`handleDriver`'s beginShift),
  // and he has not made any.
  const chepe = await row<{ id: number; status: string }>(
    "SELECT id, status FROM drivers WHERE phone = ?",
    CHEPE,
  );
  expect("Chepe has not started his shift", chepe.status, "off");
  expect(
    "claimDriver refuses a driver who is not available",
    await claimDriver(db, chepe.id, trip.id, T0 + 12 * MINUTE),
    false,
  );

  // ── The shim's own contract ────────────────────────────────────────────────
  // `.first()` on no rows: the domain treats `null` as "no such thing" in a
  // dozen branches, and `undefined` would pass some of them.
  const missing = await db
    .prepare("SELECT id FROM trips WHERE id = ?")
    .bind(9999)
    .first<{ id: number }>();
  expect("first() on no rows is null, not undefined", missing, null);

  // A bound statement is a value, not a cursor — reusing one must not consume it.
  const pending = db.prepare("SELECT count(*) AS n FROM trips WHERE state = ?").bind("done");
  expect("a bound statement survives reuse", (await pending.first<{ n: number }>())?.n, 1);
  expect("…and gives the same answer again", (await pending.first<{ n: number }>())?.n, 1);

  expect("batch() refuses rather than half-working", throws(() => db.batch()), true);

  // sql.js leaves foreign keys off, D1 enforces them, and nothing in the happy
  // path above would notice the difference — so it is asserted directly rather
  // than assumed. A demo more permissive than production is a demo that lies.
  const pragma = await row<{ foreign_keys: number }>("PRAGMA foreign_keys");
  expect("foreign keys are on", pragma.foreign_keys, 1);
  expect(
    "…so a trip cannot point at a zone that does not exist",
    await rejects(() =>
      db
        .prepare("INSERT INTO trips (dest_zone_id, requested_at) VALUES ('ninguna', ?)")
        .bind(T0)
        .run(),
    ),
    true,
  );

  // ── The cron sweep ─────────────────────────────────────────────────────────
  // Not a flow, but phase 2 calls this on every sim tick. `prepare()` is lazy by
  // design, so a query nobody executes has never been seen by SQLite — which
  // means the only way to know the sweep's SQL is valid is to make it find
  // something. First with an empty board:
  const quiet = await sweep(13);
  expect("the sweep finds nothing stuck", quiet.length, 0);

  // Then with José's trip backdated two hours, as if his phone had died before
  // he could tap Listo. This is the path that carries the JOIN, the COALESCE,
  // and the status_events insert.
  await db
    .prepare("UPDATE trips SET state = 'assigned', done_at = NULL, assigned_at = ? WHERE id = ?")
    .bind(T0 - 120 * MINUTE, trip.id)
    .run();

  const nudged = await sweep(14);
  expect("a trip left open for two hours draws a nudge", nudged.length, 1);
  expectSpec("…asking about the right destination", -1, {
    kind: "buttons",
    body: "¿Ya terminó el viaje a *Parque Arqueológico*?",
    buttons: [
      { id: "drv:done", title: copy.driver.buttons.done },
      { id: "drv:break", title: copy.driver.buttons.break },
    ],
  });

  // The guard against pestering him every minute is a status_events row read
  // back through a bare `.first()` with no type parameter — a shape the shim has
  // to get right, since `null` there would mean a nudge on every tick.
  expect("…recorded once", await count("SELECT count(*) AS n FROM status_events"), 1);
  expect("and the next sweep leaves him alone", (await sweep(15)).length, 0);

  console.log(`\n${checks} checks passed. The domain runs on sql.js unmodified.\n`);
  db.close();
}

// ── Driving the domain ───────────────────────────────────────────────────────

/** Deliver one inbound event at a sim minute, then print what went out. */
async function beat(
  minute: number,
  from: string,
  payload: InboundPayload,
  messageId?: string,
): Promise<string> {
  const at = T0 + minute * MINUTE;
  const id = messageId ?? `demo.${++messageSeq}`;
  const before = transport.sent.length;

  console.log(`\n${clock(at)}  ${NAMES[from] ?? from} → ${describeInbound(payload)}`);

  const ctx = createFlowContext(db, transport, at);
  await handleInbound(ctx, { from, messageId: id, at, payload });

  report(before);
  return id;
}

/** One turn of the cron trigger, returning whatever it decided to say. */
async function sweep(minute: number): Promise<OutboundMessage[]> {
  const at = T0 + minute * MINUTE;
  const before = transport.sent.length;

  console.log(`\n${clock(at)}  (cron sweep)`);
  await sweepStuckState(createFlowContext(db, transport, at));

  return report(before);
}

function report(before: number): OutboundMessage[] {
  const fresh = transport.sent.slice(before);
  if (fresh.length === 0) console.log("          (nothing)");
  for (const message of fresh) console.log(describeOutbound(message));
  return fresh;
}

// ── Assertions ───────────────────────────────────────────────────────────────

function expect<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`FAILED ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
  checks += 1;
  console.log(`  ✓ ${label}`);
}

/** Deep-compare one sent spec against what the copy module says it should be. */
function expectSpec(label: string, index: number, expected: OutboundSpec): void {
  const actual = nth(index).spec;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAILED ${label}\n  expected: ${b}\n  actual:   ${a}`);
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/** Negative indexes count back from the most recent message, as in Python. */
function nth(index: number): OutboundMessage {
  const message = transport.sent.at(index);
  if (!message) throw new Error(`no outbound message at index ${index}`);
  return message;
}

function lastSpec(): OutboundSpec {
  return nth(-1).spec;
}

function rowIds(spec: OutboundSpec): string[] {
  if (spec.kind !== "list") throw new Error(`expected a list, got ${spec.kind}`);
  return spec.sections.flatMap((s) => s.rows.map((r) => r.id));
}

// ── Reading state back through the shim ──────────────────────────────────────

async function row<T>(sql: string, ...params: unknown[]): Promise<T> {
  const found = await db.prepare(sql).bind(...params).first<T>();
  if (found === null) throw new Error(`no row for: ${sql}`);
  return found;
}

async function count(sql: string): Promise<number> {
  return (await row<{ n: number }>(sql)).n;
}

async function driverName(id: number): Promise<string> {
  return (await row<{ name: string }>("SELECT name FROM drivers WHERE id = ?", id)).name;
}

// ── Printing ─────────────────────────────────────────────────────────────────

function describeInbound(payload: InboundPayload): string {
  switch (payload.kind) {
    case "text":
      return `"${payload.text}"`;
    case "location":
      return `📍 ${payload.lat}, ${payload.lng}`;
    case "button":
      return `[${payload.title}]  (${payload.id})`;
    case "list":
      return `row "${payload.title}"  (${payload.id})`;
    case "other":
      return payload.description;
  }
}

function describeOutbound(message: OutboundMessage): string {
  const spec = message.spec;
  const head = `          → ${NAMES[message.to] ?? message.to}  [${spec.kind}]`;
  const lines: string[] = [head];
  const body = (text: string) => {
    for (const line of text.split("\n")) lines.push(`             ${line}`);
  };

  switch (spec.kind) {
    case "text":
    case "locationRequest":
      body(spec.body);
      break;
    case "location":
      body(`${spec.lat}, ${spec.lng}  ${spec.name ?? ""}`);
      break;
    case "buttons":
      body(spec.body);
      lines.push(`             ${spec.buttons.map((b) => `[ ${b.title} ]`).join("  ")}`);
      break;
    case "list":
      body(spec.body);
      lines.push(`             « ${spec.buttonLabel} »`);
      for (const section of spec.sections) {
        for (const r of section.rows) lines.push(`               · ${r.title}  (${r.id})`);
      }
      break;
  }
  return lines.join("\n");
}

/** Sim time as a wall clock face, for output that reads like the demo day. */
function clock(at: number): string {
  const minutes = Math.floor(at / MINUTE) % (24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The bytes, not a path: phase 6 inlines this as base64 because `file://` blocks
 * fetching a sibling .wasm. Resolved through node's resolver rather than a
 * relative path, since this script runs from `demo/dist/`.
 */
function loadWasm(): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(readFileSync(join(dirname(require.resolve("sql.js")), "sql-wasm.wasm")));
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
