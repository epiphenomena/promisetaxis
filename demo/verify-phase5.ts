/**
 * Phase 5's proof: the scripted hour runs itself, start to finish, and runs the
 * same way twice.
 *
 * Seven runs, each answering a different question.
 *
 *   A  the hour, unattended, with a screenshot at every beat       → look at these
 *   B  the same hour in a second fresh page                        → byte-identical to A
 *   C  the same hour started a second time in page B               → identical to A once
 *                                                                    the page-lifetime
 *                                                                    counters are stripped
 *   D  the hour with a person taking a phone mid-morning           → it carries on coherently
 *   E  the page with no probe on it at all                         → the frame loop works
 *   F  a tap by an NPC and a tap by a person, mid-press            → look at these too
 *   G  the same hour at 30×, in the coarsest frame there is        → the same town
 *
 * B is the R4 claim. C is the "↻ Repetir la hora" claim, and it is a weaker
 * comparison on purpose: message ids and thread ordinals are counters for the life
 * of the *page*, so a restart in place continues them. Everything that is a fact
 * about the town — every inbound event's time and payload, every row, every line in
 * the log, the zone-time strip — has to match anyway.
 *
 * Two things are asserted here that no screenshot can settle:
 *
 *   **Which code path chained the queued trip.** `offerNextTrip` (`driver.ts:104`)
 *   and `retryPendingHails` (`sweep.ts:33`) both end in `copy.customer.driverOnWay`
 *   with identical wording, and only one of them is the beat the hour is built
 *   around. They are told apart by the clock: `offerNextTrip` runs inside
 *   `handleInbound`, where `ctx.now` is the causing event's own `at`, while the
 *   sweep runs at the frame's instant. So an assignment whose `assigned_at` is
 *   exactly some delivered driver event's `at` came from the driver's tap, and one
 *   that matches nothing came from the cron.
 *
 *   **What the matrix actually learned.** `learnZoneTime` measures
 *   `doneAt − assigned_at` and subtracts the trip's own `approach_min`, so the
 *   `pickup → dest` cell is taught the ride and not the drive across town to fetch
 *   the passenger — and a hand-seeded row is blended as one observation rather than
 *   overwritten. Both are checked per cell, against the trips that taught them, and
 *   the report prints what the identical hour would have produced without either
 *   correction. That column is the evidence; `×2.09` beside `×1.05` is the whole
 *   difference the fix made, on one seed, with one variable changed.
 *
 * Run it with `npm run demo:verify:hour`. The CDP driver is Phase 4's, unchanged.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { formatSimTime, SIM_EPOCH } from "./src/clock";

// ── The cast, as the scenario names it ───────────────────────────────────────

const JOSE = "50499990001";
const MARVIN = "50499990002";
const ROSA = "50499990003";
const CHEPE = "50499990004";

const ANA = "50488880001";
const BETO = "50488880002";
const CARLA = "50488880003";
const WILMER = "50488880004";
const DELMY = "50488880005";
const ELENA = "50488880006";

/**
 * One pace the hour can be stepped at: a speed, and a frame's worth of sim time at
 * that speed.
 *
 * Two of them, because "the same hour" has to mean the same hour at either end of
 * the speed control. `SimClock` clamps a frame at 250 real ms *before* multiplying by
 * the speed, so the sim jump a single tick can make is `speed × 250` at worst — and
 * what a coarser jump changes is how many events one drain has to carry and how far
 * apart a leg ending and the frame that notices it can be. Stepping is the only way
 * to ask that question at a fixed size rather than at whatever the machine managed.
 */
type Pace = { speed: number; stepSimMs: number; stepsPerMinute: number };

/**
 * 12×, inside the clamp with room to spare: 200 real ms × 12 is 2400 sim ms, and 25
 * of those is exactly one sim minute — which is what lets a screenshot land on the
 * minute it claims.
 */
const NARRATED: Pace = { speed: 12, stepSimMs: 2400, stepsPerMinute: 25 };

/**
 * 30×, at the coarsest frame the clock will believe.
 *
 * 250 real ms × 30 is 7500 sim ms: the largest jump any tick in this demo can make,
 * and eight of them to the sim minute. Deliberately the worst case rather than a
 * typical one — a 60 Hz frame at 30× is 500 sim ms, which is nothing new, while this
 * is the frame a busy machine or a tab coming back to the front delivers.
 */
const FASTEST: Pace = { speed: 30, stepSimMs: 7500, stepsPerMinute: 8 };

/**
 * How long the harness is willing to wait for the hour to end itself.
 *
 * Not the length of the hour: the page stops when the last beat has fired and the
 * last trip has closed, which is a fact about the town and not a clock reading. This
 * is the patience, and reaching it is a failure rather than an ending.
 */
const HOUR_CAP = 67;

/**
 * Where a screenshot is taken, and what it is of.
 *
 * Keyed by sim minute because that is what the hour is written in. Taken *after*
 * the minute has been stepped through, so "09:11 the chain" is the page as it
 * looks having just played it.
 */
const SHOT_AT: Record<number, string> = {
  2: "01-shift-start",
  3: "02-instant-assign",
  7: "03-bandera-and-break",
  8: "04-fleet-busy-beto-queued",
  9: "05-break-refused-midtrip",
  13: "06-the-chain",
  14: "07-carla-queued-behind-marvin",
  17: "08-the-chain-again",
  24: "09-two-trips-underway",
  31: "10-free-text",
  34: "11-break-accepted",
  35: "12-otro-lugar-queued",
  37: "13-cancelled-while-pending",
  39: "14-drivers-back",
  44: "15-out-to-the-gas-station",
  48: "16-learning-trip-assigned",
  59: "17-zone-time-learned",
};

const SHOTS = join(process.cwd(), "demo", "dist", "shots");

let checks = 0;

// ── Types shared with the page ───────────────────────────────────────────────

type SlotView = {
  role: "customer" | "driver";
  phone: string | null;
  label: string;
  pinned: boolean;
  retained: boolean;
  word: string;
  adoptedAt: number;
  thread: string[];
};

/** One control lit as pressed, as `__demo.presses()` reports it. */
type Lit = { phone: string; kind: string; label: string };

type Payload =
  | { kind: "text"; text: string }
  | { kind: "location"; lat: number; lng: number }
  | { kind: "button"; id: string; title: string }
  | { kind: "list"; id: string; title: string };

type Trace = {
  seed: number;
  now: number;
  inbound: { id: string; at: number; from: string; payload: Payload }[];
  outbound: { at: number; to: string; kind: string; body: string | null }[];
  trips: {
    id: number;
    source: string;
    customer_phone: string | null;
    pickup_zone_id: string | null;
    dest_zone_id: string | null;
    dest_label: string | null;
    driver_id: number | null;
    state: string;
    quoted_wait_min: number | null;
    approach_min: number | null;
    requested_at: number;
    assigned_at: number | null;
    done_at: number | null;
    canceled_reason: string | null;
  }[];
  drivers: { id: number; phone: string; status: string; zone_id: string | null }[];
  zoneTimes: { from_zone: string; to_zone: string; minutes: number; samples: number }[];
  statusEvents: { driver_id: number; status: string; at: number }[];
  sessions: { phone: string; role: string; state: string }[];
  ticker: string[];
  learned: string;
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  build();
  mkdirSync(SHOTS, { recursive: true });
  // This run's own pictures go first. A renamed beat otherwise leaves the old file
  // behind, and a directory somebody is asked to *look at* then contains two
  // versions of the same minute with no way to tell which is this build's.
  for (const stale of readdirSync(SHOTS)) {
    if (stale.startsWith("hour-")) rmSync(join(SHOTS, stale));
  }

  const site = await serveDir(join(process.cwd(), "demo"));
  const browser = await Browser.launch();

  try {
    console.log("\n  ── A: the hour, unattended, with screenshots ─────────────\n");
    const pageA = await browser.open(`http://127.0.0.1:${site.port}/index.html#probe=1`);
    await atRest(pageA);
    const runA = await runHour(pageA, { shots: true, label: "A" });

    console.log("\n  ── What the hour did ─────────────────────────────────────\n");
    report(runA);

    console.log("\n  ── The beats, one at a time ──────────────────────────────\n");
    assertBeats(runA);

    console.log("\n  ── The page with the hour over ───────────────────────────\n");
    await assertFinished(pageA, runA);

    console.log("\n  ── B: the same hour in a second page ─────────────────────\n");
    const pageB = await browser.open(`http://127.0.0.1:${site.port}/index.html#probe=1`);
    const runB = await runHour(pageB, { shots: false, label: "B" });
    diff("A vs B, byte for byte", runA.raw, runB.raw);

    console.log("\n  ── C: the hour started again in the same page ────────────\n");
    const runC = await runHour(pageB, { shots: false, label: "C" });
    diff(
      "A vs C, ignoring the page's own message ids and ordinals",
      stripCounters(runA.raw),
      stripCounters(runC.raw),
    );

    console.log("\n  ── D: somebody takes a phone mid-morning ─────────────────\n");
    const pageD = await browser.open(`http://127.0.0.1:${site.port}/index.html#probe=1`);
    await takeControlRun(pageD);

    console.log("\n  ── E: the page as a viewer opens it ──────────────────────\n");
    const pageE = await browser.open(`http://127.0.0.1:${site.port}/index.html`);
    await frameDrivenRun(pageE);

    console.log("\n  ── F: the control that was pressed ───────────────────────\n");
    const pageP = await browser.open(`http://127.0.0.1:${site.port}/index.html#probe=1`);
    await pressesShow(pageP);

    console.log("\n  ── G: the same hour at 30×, in the coarsest frames ───────\n");
    const pageF = await browser.open(`http://127.0.0.1:${site.port}/index.html#probe=1`);
    const runF = await runHour(pageF, { shots: false, label: "G", pace: FASTEST });
    sameTown(runA, runF);

    const noise = [
      ...pageA.problems,
      ...pageB.problems,
      ...pageD.problems,
      ...pageE.problems,
      ...pageF.problems,
      ...pageP.problems,
    ];
    if (noise.length > 0) {
      throw new Error(`FAILED the browser logged ${noise.length} problem(s):\n  ${noise.join("\n  ")}`);
    }
    say("no page logged a console error, a warning or an exception");

    console.log(`\n${checks} checks passed. Screenshots in demo/dist/shots — look at them.\n`);
  } finally {
    await browser.close();
    site.close();
  }
}

// ── The page before anything happens ─────────────────────────────────────────

async function atRest(page: Page): Promise<void> {
  const slots = await page.slots();
  expect("four empty slots before the hour starts", slots.every((s) => s.phone === null), true);
  expect(
    "each one says how to start the hour",
    await page.eval<number>("document.querySelectorAll('.slot__empty-hint').length"),
    4,
  );
  expect(
    "the hour control offers to start",
    await page.eval<string>("document.getElementById('hour').textContent"),
    "🎬 Empezar la hora",
  );
  expect(
    "four speeds are offered, labelled the same way",
    await page.eval<string>(
      `[...document.querySelectorAll('#speeds button')].map((b) => b.textContent).join(" ")`,
    ),
    "1× 4× 12× 30×",
  );
  expect(
    "…and the fastest says what one × is, because “30×” alone says nothing",
    await page.eval<string>(`document.querySelector('#speeds button[data-speed="30"]').title`),
    "Un minuto del pueblo cada 2 segundos.",
  );
  expect(
    "…with the speed the page opens on marked, and it is not the fastest",
    await page.eval<string>(`document.querySelector('#speeds button[aria-pressed="true"]').dataset.speed`),
    "4",
  );
  expect(
    "the zone-time strip says the matrix is still hand-written",
    (await page.learned()).includes("alguien escribió a mano"),
    true,
  );
  expect("…and has not moved", await page.eval<string>("document.querySelector('.learn').dataset.moved"), "false");
  await page.shot("hour-00-before-the-hour");
}

// ── The hour ─────────────────────────────────────────────────────────────────

type Run = { raw: string; stopped: string; trace: Trace };

/**
 * Press the hour control and step through to the end.
 *
 * Both runs follow the same step schedule to the tick. That is not fussiness:
 * `transport.send` stamps a message with the clock's current reading, so the
 * timestamps on the refusal lines in the log are a function of which frame ran the
 * drain. Identical stepping is what makes them comparable — the claim being proved
 * is that the same schedule gives the same hour, not that the hour is independent
 * of the frame rate.
 */
async function runHour(page: Page, opts: { shots: boolean; label: string; pace?: Pace }): Promise<Run> {
  const pace = opts.pace ?? NARRATED;

  await page.startHour();
  // After the press, not before: the previous hour may have ended in this same page,
  // and a finished page disables the speeds along with ▶ (there is nothing left to
  // run). The speed is not cosmetic either — it is the divisor `step` turns a sim
  // jump back into real milliseconds with, so the pace above only holds if the
  // button took.
  await page.click(
    `[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '${pace.speed}×')`,
  );
  expect(
    `the clock is running at ${pace.speed}×`,
    await page.eval<string>(
      `document.querySelector('#speeds button[data-speed="${pace.speed}"]').getAttribute('aria-pressed')`,
    ),
    "true",
  );

  /** The clock face the hour stopped itself on, once it has. */
  let stopped: string | null = null;
  /** The most controls any one phone had lit at the same instant. See below. */
  let lit = 0;

  for (let minute = 1; minute <= HOUR_CAP; minute += 1) {
    await page.minutes(1, pace);
    // Sampled every minute at both paces, because "the press must not smear into the
    // next tap" is the one claim about it that a coarse frame could break. It cannot:
    // a new press ends the phone's previous one, so the invariant is one lit control
    // per phone — and this is where that stops being an argument.
    lit = Math.max(lit, await page.litPerPhone());
    const name = SHOT_AT[minute];
    if (opts.shots && name) {
      await page.shot(`hour-${name}`);
      await peek(page, minute);
    }
    // Asked after the minute rather than before it, so `stopped` is the face of the
    // minute the clock froze on and not of the one after.
    if (await page.over()) {
      stopped = await page.clockFace();
      break;
    }
  }

  expect(
    `at ${pace.speed}×, no phone ever had two controls lit at once`,
    lit <= 1,
    true,
  );
  expect("the script has run out and nobody is mid-thought", await page.scripted(), true);
  expect(
    `the hour ended itself rather than running on into an empty town (cap ${HOUR_CAP} min)`,
    stopped !== null,
    true,
  );
  say(`the hour stopped at ${stopped}`);

  const raw = await page.trace();
  // Kept next to the screenshots. When a beat stops firing, the trace is what says
  // which message the conversation stalled on, and reconstructing it from a failed
  // assertion is an afternoon.
  writeFileSync(join(SHOTS, "..", `trace-${opts.label}.json`), raw);
  return { raw, stopped: stopped!, trace: JSON.parse(raw) as Trace };
}

/**
 * What has to be true on the page at the minute a picture was taken.
 *
 * The pictures are the point of the screenshots and a pair of eyes is what reads
 * them — but a few of these are things eyes are bad at, because the phones are
 * short enough that a two-message reply scrolls the first one out of sight. What
 * is in the thread and what is visible in it are different questions, and only the
 * first one can be settled here.
 */
async function peek(page: Page, minute: number): Promise<void> {
  if (minute === 9) {
    expect(
      "the refused break is on Marvin's own phone, under the trip card the refusal re-sent",
      (await page.slotOf(MARVIN))?.thread.some((m) => m.includes("Primero termine el viaje actual")),
      true,
    );
    expect(
      "…and his slot still says he has a trip open",
      (await page.slotOf(MARVIN))?.word,
      "Con viaje abierto",
    );
  }

  if (minute === 13) {
    const beto = await page.slotOf(BETO);
    expect("at the chain, Beto is in the slot he has had since 09:07", stamp(beto?.adoptedAt ?? null).slice(0, 5), "09:07");
    expect("…and the message he waited five minutes for is on it", beto?.thread.some((m) => m.includes("viene por usted ahora")), true);
    expect("…while the strip has already moved once", await page.eval<string>("document.querySelector('.learn').dataset.moved"), "true");
  }

  if (minute === 24) {
    // Mid-run rather than at rest, because the two things this phase added to the
    // page — the zone-time strip and the hour control — only have their interesting
    // colours once something has happened, and the palette they take them from is
    // defined once and swapped by token. Nothing here touches the clock or the
    // queue, so run A and run B still walk the same hour.
    await page.click(`document.getElementById('theme')`);
    await page.shot("hour-09b-dark");
    expect(
      "the zone-time strip keeps its jade in the dark theme rather than going transparent",
      await page.eval<boolean>(
        `getComputedStyle(document.querySelector('.learn')).backgroundColor !== 'rgba(0, 0, 0, 0)'`,
      ),
      true,
    );
    await page.click(`document.getElementById('theme')`);
  }

  if (minute === 35) {
    expect(
      "an empty slot mid-morning no longer asks for the hour to be started",
      await page.eval<boolean>(
        `[...document.querySelectorAll('.slot__empty-hint')].every((el) => el.offsetParent === null)`,
      ),
      true,
    );
  }
}

// ── The end of the hour ──────────────────────────────────────────────────────

/**
 * The page a presentation actually finishes on.
 *
 * Before this existed the last beat played and the clock carried on over an empty
 * town, which is the worst possible last impression: the thing a viewer is left
 * looking at is a service with nothing to do. So four claims, and the first is the
 * only one a screenshot could not settle — that sim time has genuinely stopped and
 * not merely run out of things to show.
 */
async function assertFinished(page: Page, run: Run): Promise<void> {
  const before = await page.now();
  await page.minutes(2);
  expect("the clock does not move again, however long the page is left open", await page.now(), before);

  expect(
    "▶ is dead, because there is nothing left for it to run",
    await page.eval<boolean>("document.getElementById('play').disabled"),
    true,
  );
  expect(
    "…and so are the speeds, for the same reason",
    await page.eval<boolean>("[...document.querySelectorAll('#speeds button')].every((b) => b.disabled)"),
    true,
  );
  expect(
    "the one thing left to press offers to run the hour again",
    await page.eval<string>("document.getElementById('hour').textContent"),
    "↻ Repetir la hora",
  );
  expect(
    "…and is ringed so a room can see where to look",
    await page.eval<boolean>(
      `getComputedStyle(document.getElementById('hour')).boxShadow.includes('3px')`,
    ),
    true,
  );

  // The log's own last word, and the tally in it counted out of the tables rather
  // than written by hand into a beat — which is what makes it survive a viewer who
  // took a phone and changed what happened.
  const log = run.trace.ticker;
  const closing = log[log.length - 2] ?? "";
  expect("the log says the hour is over", closing.includes("Terminó la hora"), true);
  expect(
    "…with the six trips it actually closed, counted from `trips`",
    closing.includes("6 viajes cerrados"),
    true,
  );
  expect("…and the flagged-down one named as one of them", closing.includes("uno de ellos de bandera"), true);
  expect("…the cancellation", closing.includes("1 solicitud cancelada"), true);
  expect("…the two breaks", closing.includes("2 descansos"), true);
  expect(
    "…and the matrix cells the hour corrected, counted from `zone_times`",
    closing.includes("casillas de la matriz corregidas"),
    true,
  );
  expect(
    "…and it is stamped with the minute the clock froze on, so the log still reads downwards",
    (log[log.length - 1] ?? "").slice(0, 5),
    run.stopped,
  );
  expect("the last line points at the way to see it again", has(log, "Pulse ↻ Repetir la hora"), true);

  await page.shot("hour-18-the-hour-is-over");

  // The one way out of a stopped page, and it has to stay open.
  //
  // Taking a phone once the hour is over is the only thing that can give the page
  // something to run again — a person can hail — so the finished state is released
  // and ▶ comes back. The second assertion is the one that matters: the release has
  // to survive the pumps that follow it, and the first draft of this did not. The
  // script is still spent and no trip is open, so a halt guarded only on "is the page
  // stopped" halted again on the very next frame and handed the viewer live glass
  // with a dead clock.
  const slot = `.slot[data-phone="${MARVIN}"]`;
  await page.click(`document.querySelector('${slot} .slot__take')`);
  expect(
    "taking a phone after the end gives the clock back",
    await page.eval<boolean>("document.getElementById('play').disabled"),
    false,
  );
  await page.minutes(2);
  expect(
    "…and it stays given: the hour ends once, not once a frame",
    await page.eval<boolean>("document.getElementById('play').disabled"),
    false,
  );
  expect(
    "…with the page no longer dressed as finished",
    await page.eval<string>("document.documentElement.dataset.hour"),
    "running",
  );
  await page.click(`document.querySelector('${slot} .slot__take')`);
}

/**
 * Two paces, one town.
 *
 * What a coarser frame is allowed to move, and what it is not, falls straight out of
 * where each number comes from. Every inbound event is stamped with `queue.runningAt`
 * — the sim instant the *domain* is running at — plus a think-time, rooted in a beat's
 * own fixed minute, and a leg hand-off is anchored on the leg's scheduled end rather
 * than on the frame that noticed it. All of that is frame-independent, and with it
 * every row the domain wrote. What is not: `transport.send` stamps a message with the
 * clock's reading at the frame that ran the drain, so the outbound times and the log
 * stamps derived from them legitimately differ between two paces. Phase 5's own claim
 * has always been that the same *schedule* gives the same hour, not that the hour is
 * independent of the frame rate.
 *
 * So masking those two and demanding the rest match byte for byte is the direct
 * answer to "does 30× swallow or reorder a beat?" — the inbound log and the trips are
 * in the comparison, in order, to the millisecond.
 */
function sameTown(a: Run, b: Run): void {
  diff(
    "A at 12× vs G at 30×, once the frame's own clock readings are masked",
    maskFrameStamps(a.raw),
    maskFrameStamps(b.raw),
  );
  expect("…and both paces stopped the hour on the same minute", a.stopped, b.stopped);
  expect(
    "…having delivered exactly the same events",
    JSON.stringify(b.trace.inbound),
    JSON.stringify(a.trace.inbound),
  );
}

function maskFrameStamps(raw: string): string {
  const trace = JSON.parse(raw) as Trace;
  trace.now = 0;
  for (const message of trace.outbound) message.at = 0;
  trace.ticker = trace.ticker.map((line) => line.replace(/^\d\d:\d\d /, "--:-- "));
  return JSON.stringify(trace, null, 1);
}

// ── What happened ────────────────────────────────────────────────────────────

function report(run: Run): void {
  const { trace } = run;

  for (const line of trace.ticker) console.log(`    ${line}`);

  console.log("\n    trips");
  for (const trip of trace.trips) {
    const who = trip.customer_phone ? NAMES[trip.customer_phone] ?? trip.customer_phone : "bandera";
    console.log(
      `      #${String(trip.id).padEnd(2)} ${who.padEnd(7)} ` +
        `${(trip.pickup_zone_id ?? "—").padEnd(14)} → ${(trip.dest_zone_id ?? "—").padEnd(14)} ` +
        `${trip.state.padEnd(9)} driver ${String(trip.driver_id ?? "—").padEnd(2)} ` +
        `pedido ${stamp(trip.requested_at)} asignado ${stamp(trip.assigned_at)} ` +
        `cerrado ${stamp(trip.done_at)} quote ${trip.quoted_wait_min ?? "—"}`,
    );
  }

  console.log("\n    zone_times the hour moved");
  console.log(
    "      from            → to               seeded  learned   ×     " +
      "if the approach were not subtracted",
  );
  for (const cell of trace.zoneTimes) {
    const seeded = SEEDED_MATRIX[`${cell.from_zone}→${cell.to_zone}`];
    const drift = seeded === undefined ? "" : `×${(cell.minutes / seeded).toFixed(2)}`;
    console.log(
      `      ${cell.from_zone.padEnd(15)} → ${cell.to_zone.padEnd(15)} ` +
        `${(seeded ?? "?").toString().padStart(5)}  ` +
        `${cell.minutes.toFixed(2).padStart(6)}  ${drift.padStart(6)}  ` +
        `${counterfactual(trace, cell.from_zone, cell.to_zone, seeded)}`,
    );
  }

  console.log(`\n    the strip: ${trace.learned}`);
  console.log(`    drivers at the end: ${trace.drivers.map((d) => `${d.id}:${d.status}@${d.zone_id}`).join("  ")}`);
}

const NAMES: Record<string, string> = {
  [ANA]: "Ana",
  [BETO]: "Beto",
  [CARLA]: "Carla",
  [WILMER]: "Wilmer",
  [DELMY]: "Delmy",
  [ELENA]: "Elena",
};

/**
 * The hand-written cells the hour is capable of touching, copied from
 * `seeds/dev.sql` so the table above can print a ratio.
 *
 * A copy and not a query: by the time the trace is taken the rows have been
 * overwritten by what was learned, so the seeded value is no longer anywhere in
 * the database to read. Only the pairs the scripted hour can reach are listed —
 * anything missing prints as `?` rather than as a wrong number.
 */
const SEEDED_MATRIX: Record<string, number> = {
  "barrio_abajo→centro": 5,
  "barrio_arriba→ruinas": 10,
  "barrio_arriba→barrio_abajo": 8,
  "centro→barrio_arriba": 5,
  "centro→barrio_abajo": 5,
  "centro→ruinas": 7,
  "ruinas→centro": 7,
  "salida_florido→centro": 6,
};

/**
 * What this same hour would have taught the same cell under the old arithmetic.
 *
 * Three demo bugs and one app bug were found by building this, and the fix to
 * `learnZoneTime` is the one whose effect is a number rather than a behaviour — so
 * it is worth showing rather than asserting. Held to one variable: the trips, the
 * seed and the jitter are this run's, and the only thing changed is whether the
 * approach is subtracted (it was not) and whether a seeded row carries any weight
 * (it did not, so the first observation replaced it outright).
 *
 * A bandera is excluded from the comparison and labelled instead. Its own span is
 * shorter than it used to be — the phantom same-zone approach the domain charged
 * for a passenger already aboard is gone — so there is no counterfactual to
 * compute from this run's numbers without mixing two changes into one column.
 */
function counterfactual(
  trace: Trace,
  from: string,
  to: string,
  seeded: number | undefined,
): string {
  const trip = trace.trips.find(
    (t) => t.state === "done" && t.pickup_zone_id === from && t.dest_zone_id === to,
  );
  if (!trip || trip.assigned_at === null || trip.done_at === null) return "—";
  if (trip.source === "bandera") return "(bandera: the phantom approach is gone too)";
  const span = (trip.done_at - trip.assigned_at) / 60_000;
  const ratio = seeded === undefined ? "" : `  ×${(span / seeded).toFixed(2)}`;
  return `${span.toFixed(2)} min${ratio}`;
}

// ── Every beat, asserted ─────────────────────────────────────────────────────

function assertBeats(run: Run): void {
  const { trace } = run;
  const log = trace.ticker;

  // ── The shift starts, and one driver does not ────────────────────────────
  expect(
    "three drivers send an opening pin",
    trace.inbound.filter((e) => e.payload.kind === "location" && DRIVER_PHONES.has(e.from)).length,
    3,
  );
  expect(
    "…and the log has all three, with the zone each pin resolved to",
    log.filter((l) => l.includes("entró en turno y mandó su ubicación")).length,
    3,
  );
  // The cause, not just the outcome. First contact from a registered driver now
  // starts their shift, so "Chepe is still off" is only honest as long as nothing
  // arrived from his number — and if a beat ever did send him something, the
  // interesting failure is that he silently joins the dispatch pool a few minutes
  // before the trip the learning beat depends on. Asserting the silence is what
  // keeps this a claim about the hour rather than a claim about the app.
  expect(
    "nothing is ever sent from Chepe's number",
    trace.inbound.some((e) => e.from === CHEPE),
    false,
  );
  const chepe = trace.drivers.find((d) => d.phone === CHEPE);
  expect("…so he is still off at the end of the hour", chepe?.status, "off");
  expect(
    "…with no shift start logged for him, which is what first contact would have written",
    trace.statusEvents.some((e) => e.driver_id === chepe?.id),
    false,
  );
  expect("…and the log says so rather than leaving a grey taxi unexplained", has(log, "Chepe (#15) no entró en turno"), true);

  // ── An instant assign, to the driver the scoring rule picked ─────────────
  const ana = tripOf(trace, ANA);
  expect("Ana's hail was assigned on the spot", ana.assigned_at, ana.requested_at);
  expect("…and the customer was quoted a number, which only happens on an instant assign", ana.quoted_wait_min !== null, true);
  expect(
    "the candidate list is in the log, computed with dispatch's own rankCandidates",
    has(log, "el despacho cuenta espera + camino"),
    true,
  );
  expect("…and the minutes of the drive come from the zone matrix", has(log, "según la matriz de zonas"), true);

  // ── A flagged-down passenger ─────────────────────────────────────────────
  const bandera = trace.trips.find((t) => t.source === "bandera");
  expect("a bandera trip exists", bandera !== undefined, true);
  expect("…with no customer phone, because the passenger is already aboard", bandera?.customer_phone, null);
  expect("…and a destination the driver picked off the zone menu", bandera?.dest_zone_id, "ruinas");
  expect("…which the log reports as a street pickup", has(log, "recogió un pasajero en la calle"), true);
  expect("…and then where it went", has(log, "lleva el pasajero a Las Ruinas"), true);

  // ── A break refused, and a break taken ───────────────────────────────────
  expect(
    "the break asked for mid-trip was refused, and the refusal changed no row",
    has(log, "pidió descanso con un viaje abierto"),
    true,
  );
  expect(
    "…in the domain's own words, on the driver's own phone",
    trace.outbound.some((m) => m.to === MARVIN && m.body?.startsWith("Primero termine el viaje actual")),
    true,
  );
  expect(
    "two drivers went on break",
    trace.statusEvents.filter((e) => e.status === "break").length,
    2,
  );
  expect(
    "…and both came back, so neither holds a screen for the rest of the hour",
    trace.statusEvents.filter((e) => e.status === "available").length,
    2,
  );
  expect("the log has a break being taken", has(log, "se fue a descansar"), true);
  expect("…and one ending", has(log, "volvió al servicio"), true);

  // ── The chain, twice, and by the right path ──────────────────────────────
  //
  // "Waited" is `assigned_at > requested_at` exactly, and not a threshold in
  // seconds. An instant assign writes the two stamps from one `ctx.now`, so they
  // are equal to the millisecond; anything later was a trip left `pending` and
  // claimed by a separate event. A minimum wait dressed up as the definition is a
  // test that goes quiet when a beat drifts a few seconds — which is how a
  // one-minute queue would have gone on passing for a four-minute one.
  const chained = trace.trips.filter(
    (t) => t.state === "done" && t.source !== "bandera" && t.assigned_at! > t.requested_at,
  );
  expect("two trips waited in the list before they were assigned", chained.length, 2);
  // And the wait was long enough to watch. At 12× a sim minute is five seconds of
  // screen time, so a queue that resolves inside one of them is a mechanism nobody
  // in the room sees work.
  for (const trip of chained) {
    const waited = (trip.assigned_at! - trip.requested_at) / 60_000;
    expect(
      `${NAMES[trip.customer_phone ?? ""] ?? "?"} waited long enough to be seen waiting`,
      waited >= 2,
      true,
    );
  }

  for (const trip of chained) {
    const who = NAMES[trip.customer_phone ?? ""] ?? "?";
    const tap = trace.inbound.find(
      (e) =>
        e.at === trip.assigned_at &&
        DRIVER_PHONES.has(e.from) &&
        e.payload.kind === "button" &&
        e.payload.id === "drv:done",
    );
    // The discriminator. A sweep-driven assignment carries the frame's instant,
    // which coincides with no inbound event; this one carries the tap's own.
    expect(
      `${who}'s trip was assigned by a driver's ✅ Listo (offerNextTrip), not by the cron sweep`,
      tap !== undefined,
      true,
    );
    expect(
      `…and ${who} was told a tuktuk was coming`,
      trace.outbound.some((m) => m.to === trip.customer_phone && m.body?.includes("viene por usted ahora")),
      true,
    );
  }

  expect(
    "no assignment in the whole hour came from retryPendingHails",
    trace.trips.every(
      (t) =>
        t.assigned_at === null ||
        t.assigned_at === t.requested_at ||
        t.source === "bandera" ||
        trace.inbound.some((e) => e.at === t.assigned_at && DRIVER_PHONES.has(e.from)),
    ),
    true,
  );
  expect("the log narrates the hand-over", log.filter((l) => l.includes("Se desocupó")).length, 2);
  expect("…and says how long the customer had waited", has(log, "que esperó"), true);
  expect("the queued customers were told they were on the list", log.filter((l) => l.includes("queda en la lista")).length >= 3, true);
  expect(
    "…with a number quoted from a driver who was not free yet",
    trace.outbound.some((m) => m.body?.startsWith("✅ Anotado") && /\d+ minutos/.test(m.body)),
    true,
  );

  // ── Typing instead of tapping ────────────────────────────────────────────
  expect(
    "a place nobody put in the gazetteer is reported as not found",
    has(log, "escribió un lugar que no está en la lista"),
    true,
  );
  expect(
    "…and typing the destination reaches confirmMatch",
    log.filter((l) => l.includes("escribió el destino a mano")).length,
    2,
  );
  expect(
    "one of them got there through “Otro lugar…”",
    trace.inbound.some((e) => e.payload.kind === "list" && e.payload.id === "lm:__other__"),
    true,
  );
  expect(
    "Wilmer's trip was created from a name he typed",
    tripOf(trace, WILMER).dest_label,
    "Parque Central",
  );

  // ── A cancellation while pending ─────────────────────────────────────────
  const delmy = tripOf(trace, DELMY);
  expect("Delmy's trip was cancelled", delmy.state, "canceled");
  expect("…by her, not by the office", delmy.canceled_reason, "customer");
  expect("…and no driver was ever disturbed by it", delmy.driver_id, null);
  // The asterisks around *cancelar* are `copy.ts`'s emphasis and the ticker renders
  // them as bold, so the log's text has the word and not the markup.
  expect("…which the log says in her own word", has(log, "Delmy escribió cancelar"), true);

  // ── A driver typing instead of tapping ───────────────────────────────────
  expect(
    "a driver came back by typing the keyword rather than tapping the button",
    trace.inbound.some((e) => e.from === ROSA && e.payload.kind === "text" && e.payload.text === "disponible"),
    true,
  );

  // ── Everybody the script invited actually turned up ──────────────────────
  for (const name of Object.values(NAMES)) {
    expect(`${name} appears in the log`, has(log, name), true);
  }

  // ── The matrix moved, and the honest amount ──────────────────────────────
  const learning = trace.zoneTimes.find((c) => c.from_zone === "centro" && c.to_zone === "ruinas");
  expect("the centro→ruinas cell was taught by the last trip", learning !== undefined, true);
  expect("…once, so it is the seeded 7.0 blended with one measurement", learning?.samples, 1);
  expect(
    "the strip shows that cell, before and after",
    trace.learned.includes("Centro → Las Ruinas") && trace.learned.includes("7.0 min"),
    true,
  );
  expect("…and the log says the same numbers", has(log, "La matriz aprendió"), true);

  /**
   * Both halves of the fixed `learnZoneTime`, asserted on every cell the hour taught.
   *
   * This is the claim the demo used to have to disown on screen: cells inflated
   * ×1.22 to ×2.28 over one hour because the span measured from assignment carried
   * the driver's drive to the passenger, and `travelMinutes` reads the same cell
   * back to estimate the next approach. Two numbers now pin it.
   *
   * **The halfway property.** `weight = Math.max(1, Math.min(samples, 20))` — a
   * hand-seeded row is one observation, not none, so a cell with one measurement
   * behind it sits exactly midway between the surveyed guess and what was driven.
   * Recovering the observation as `2 × learned − seeded` and finding the trip's own
   * `span − approach_min` there is a much stronger statement than "it moved": it
   * says which minutes went in.
   *
   * **The spread.** Every cell within a quarter of its seeded value, which is the
   * ±25% the sprites are jittered by and nothing more. Under the old arithmetic the
   * same hour put cells at twice the seed; the counterfactual column in the report
   * above prints exactly that, from these same trips.
   */
  for (const cell of trace.zoneTimes) {
    const label = `${cell.from_zone}→${cell.to_zone}`;
    const seeded = SEEDED_MATRIX[label];
    expect(`${label} is a cell the seed had a value for`, seeded !== undefined, true);
    expect(`…taught once in the hour`, cell.samples, 1);

    const trip = trace.trips.find(
      (t) =>
        t.state === "done" &&
        t.pickup_zone_id === cell.from_zone &&
        t.dest_zone_id === cell.to_zone,
    );
    expect(`…by one finished trip`, trip !== undefined, true);
    const observed = (trip!.done_at! - trip!.assigned_at!) / 60_000 - (trip!.approach_min ?? 0);
    expect(
      `…out of the ride alone: ${label} learned ${cell.minutes.toFixed(2)} from a ` +
        `${observed.toFixed(2)} min ride, not the whole drive`,
      (cell.minutes * 2 - seeded!).toFixed(4),
      observed.toFixed(4),
    );
    expect(
      `…landing within the ±25% jitter of the seeded ${seeded}, not at twice it`,
      Math.abs(cell.minutes / seeded! - 1) <= 0.25,
      true,
    );
  }

  // ── The log reads downwards ──────────────────────────────────────────────
  const stamps = log.map((line) => line.slice(0, 5));
  expect(
    "every line in the log is stamped no earlier than the one above it",
    stamps.every((face, i) => i === 0 || stamps[i - 1]! <= face),
    true,
  );

  // ── Nothing was left broken ──────────────────────────────────────────────
  expect(
    "no trip was left open at the end of the hour",
    trace.trips.every((t) => t.state === "done" || t.state === "canceled"),
    true,
  );
  expect(
    "every conversation is back to idle",
    trace.sessions.every((s) => s.state === "idle" || s.state === "available"),
    true,
  );
}

const DRIVER_PHONES = new Set([JOSE, MARVIN, ROSA, CHEPE]);

function tripOf(trace: Trace, phone: string): Trace["trips"][number] {
  const trip = trace.trips.find((t) => t.customer_phone === phone);
  if (!trip) {
    throw new Error(
      `FAILED ${NAMES[phone] ?? phone} never got a trip at all\n` +
        trace.trips.map((t) => `    #${t.id} ${t.customer_phone} ${t.state}`).join("\n"),
    );
  }
  return trip;
}

// ── A person at the controls ─────────────────────────────────────────────────

/**
 * The hour with a viewer in it.
 *
 * Not a second determinism check — a human by definition changes the hour — but the
 * thing that most easily breaks: an NPC that keeps answering a phone somebody else
 * is holding, an intention that lands mid-sentence, or a trip left open because the
 * tap that would have closed it was dropped while the phone was borrowed.
 */
async function takeControlRun(page: Page): Promise<void> {
  await page.startHour();
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '12×')`);
  await page.minutes(3);

  // Marvin, on the morning's bandera. His phone is the one where a borrowed
  // moment can do real damage: the zone menu is open and the trip has nowhere to
  // go until somebody answers it.
  const slot = `.slot[data-phone="${MARVIN}"]`;
  expect(
    "Marvin is on screen three minutes into the hour",
    (await page.slotOf(MARVIN))?.role,
    "driver",
  );
  await page.click(`document.querySelector('${slot} .slot__take')`);
  expect("taking control pins the slot", (await page.slotOf(MARVIN))?.pinned, true);
  expect("…and the glass comes alive", await live(page, MARVIN), "true");

  await page.minutes(2);
  await page.type(`document.querySelector('${slot} .composer__input')`, "ayuda");
  await page.click(`document.querySelector('${slot} .composer__send')`);
  await page.settle();
  expect(
    "what a person types is an ordinary inbound event",
    (await page.slotOf(MARVIN))?.thread.some((m) => m.includes("terminar el viaje actual")),
    true,
  );
  await page.shot("hour-c1-human-driving-a-driver");

  // ✋ Bandera by hand, and the zone menu answered by hand, while the NPC that
  // would normally do it sits out.
  await page.click(
    `[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Bandera'))`,
  );
  await page.settle();
  await page.click(
    `[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Ver zonas'))`,
  );
  await page.click(
    `[...document.querySelectorAll('${slot} .sheet__row')].find((r) => r.textContent.includes('Barrio abajo'))`,
  );
  await page.settle();
  expect(
    "a bandera driven entirely by hand reaches the same place",
    (await page.ticker()).some((l) => l.includes("lleva el pasajero a Barrio abajo")),
    true,
  );
  await page.shot("hour-c2-human-bandera");

  // Held past 09:06, which is when the script would have had Marvin tap ✋ himself.
  // An NPC's intention is dropped while a person has the phone, so the borrowed
  // window has to cover the beat it is replacing: hand back first and Marvin taps
  // ✋ a second time, `onBandera` closes the trip the person started to open
  // another, and the run below would be comparing two banderas rather than one.
  await page.minutes(2);

  await page.click(`document.querySelector('${slot} .slot__take')`);
  expect("releasing hands the phone back", (await page.slotOf(MARVIN))?.pinned, false);
  expect("…and the glass goes dead again", await live(page, MARVIN), "false");

  // Now let the rest of the hour play out with the NPC back in charge. The trip the
  // person started is the NPC's to finish, which is the property that matters: an
  // obligation formed while the phone was borrowed must not be lost.
  for (let minute = 0; minute < HOUR_CAP; minute += 1) {
    await page.minutes(1);
    if (await page.over()) break;
  }

  const raw = await page.trace();
  writeFileSync(join(SHOTS, "..", "trace-D.json"), raw);
  const trace = JSON.parse(raw) as Trace;
  // The discriminator for whether a person changed the hour at all. The scripted
  // bandera goes to Las Ruinas; the one driven by hand went to Barrio abajo, and
  // `learnZoneTime` files a finished trip under its own zone pair — so which cell
  // exists says, with no argument, whose bandera the town actually ran.
  expect(
    "the hour really was driven off its script: the matrix learned the cell the *person* chose",
    trace.zoneTimes.some((c) => c.from_zone === "barrio_arriba" && c.to_zone === "barrio_abajo"),
    true,
  );
  expect(
    "…and not the one the beat would have chosen",
    trace.zoneTimes.some((c) => c.from_zone === "barrio_arriba" && c.to_zone === "ruinas"),
    false,
  );
  expect(
    "the trip a person started was closed by the driver who took it over",
    trace.trips.every((t) => t.state === "done" || t.state === "canceled"),
    true,
  );
  expect(
    "every driver ends the hour where the board can reach them",
    trace.drivers.every((d) => d.status === "available" || d.status === "off"),
    true,
  );
  expect("…and the matrix still learned the last trip", trace.zoneTimes.length >= 4, true);
  expect("the script still finished", await page.scripted(), true);
  await page.shot("hour-c3-after-the-hand-back");
  console.log(`    the strip, after a borrowed phone: ${trace.learned}`);
  console.log(
    `    cells taught: ${trace.zoneTimes.map((c) => `${c.from_zone}→${c.to_zone} ${c.minutes.toFixed(2)}`).join(", ")}`,
  );
}

// ── The control that was pressed ─────────────────────────────────────────────

/**
 * What was tapped, on screen, at the moment the tap goes in.
 *
 * The pictures this leaves are the point — a reply button mid-press and a list row
 * mid-press are two of the four images a reader is asked to look at — but three
 * things here are claims a picture cannot make.
 *
 * **It is not a human affordance.** The first press caught below is an NPC's, on a
 * phone nobody has touched, found by stepping the hour a tick at a time until one
 * lights up. Nothing in this function asks for it: the highlight exists because
 * `phone.ts` read a delivered `InboundEvent` as it was drained.
 *
 * **A person's tap gets the same treatment.** The second and third presses are driven
 * by a real mouse through a phone somebody has taken, and they light the same way,
 * through the same code, because the event is the same event (R1).
 *
 * **It is legible at 30×.** The last one is caught at the fastest speed, in the
 * coarsest frame the clock will believe, which is where a flash tuned against
 * think-times would have vanished.
 */
async function pressesShow(page: Page): Promise<void> {
  await page.startHour();
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '12×')`);
  await page.minutes(5);

  // A person first, on the phone the morning's ✋ happens on.
  const slot = `.slot[data-phone="${MARVIN}"]`;
  await page.click(`document.querySelector('${slot} .slot__take')`);

  await page.click(
    `[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Bandera'))`,
  );
  await page.settle();
  // Filtered to this phone. `presses()` reports the whole page, and the rule is one
  // lit control *per phone* — at this minute an NPC two rectangles away is answering
  // something of its own.
  const tapped = (await page.presses()).filter((lit) => lit.phone === MARVIN);
  expect("a person's tap lights exactly one control on their phone", tapped.length, 1);
  expect("…named as the reply button it is", tapped[0]?.kind, "button");
  expect(
    "…and it is the ✋ and not one of the two beside it",
    await page.eval<string>(`document.querySelector('${slot} .action[data-pressed]').dataset.tapId`),
    "drv:bandera",
  );
  expect(
    "…settling into the wash rather than pulsing, so a screenshot catches a state",
    await page.eval<string>(
      `getComputedStyle(document.querySelector('${slot} .action[data-pressed]')).animationName`,
    ),
    "press-land",
  );
  expect("…and on the glass, not merely set on an element", await page.pressOnGlass(MARVIN), true);
  await page.shot("hour-p1-a-reply-button-mid-press", { midPress: true });

  // The zone menu the ✋ produces, answered by hand: the row is the choice, so the
  // sheet has to be on screen with the row marked and not just the button that opened
  // it. This is the case the whole change exists for.
  await page.click(
    `[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Ver zonas'))`,
  );
  await page.click(
    `[...document.querySelectorAll('${slot} .sheet__row')].find((r) => r.textContent.includes('Barrio abajo'))`,
  );
  await page.settle();
  const picked = (await page.presses()).filter((lit) => lit.phone === MARVIN);
  expect("picking a row lights one thing, and it is the row", picked.length, 1);
  expect("…named as a row and not as the button that opened the sheet", picked[0]?.kind, "row");
  expect("…the one that was picked", picked[0]?.label, "Barrio abajo");
  const sheet = await page.eval<{ open: boolean; row: string; inert: boolean }>(
    `(() => {
       const s = document.querySelector('${slot} .sheet');
       const row = s.querySelector('.sheet__row[data-pressed]');
       return {
         open: !s.hidden && s.getBoundingClientRect().height > 0,
         row: row ? row.textContent : "",
         inert: [...s.querySelectorAll('.sheet__row')].every((r) => r.disabled),
       };
     })()`,
  );
  expect("…with the sheet back on screen, which is what makes the choice legible", sheet.open, true);
  expect("…and the row's own words in it", sheet.row.includes("Barrio abajo"), true);
  expect(
    "…every row of it dead, so a sheet being shown can never be a sheet being offered",
    sheet.inert,
    true,
  );
  expect("…and the row itself is in view, however long the menu", await page.pressOnGlass(MARVIN), true);
  await page.shot("hour-p2-a-list-row-mid-press", { midPress: true });

  // Hand it back, and then wait for an NPC to make the same kind of choice by itself,
  // on a phone nobody has touched. If it lights the way the two above did, the
  // highlight is a reading of the delivered event and not an affordance of being human.
  await page.click(`document.querySelector('${slot} .slot__take')`);

  // Put the person's own press out before hunting for an NPC's, or the first thing
  // found is the row *they* just picked — still lit, because a press outlives the tap
  // by 450 ms. The claim being made is about a phone nobody is driving.
  await page.eval("window.__demo.clearPresses()");
  const alone = await waitFor(
    () => page.stepUntilPressed(NARRATED, (p) => p.kind === "row"),
    "no NPC ever picked a row",
  );
  expect("an NPC picking a row lights it the same way", alone.kind, "row");
  expect(
    "…on a phone nobody is driving",
    await page.eval<boolean>(
      `document.querySelector('.slot[data-phone="${alone.phone}"] .phone').dataset.live === "false"`,
    ),
    true,
  );
  expect("…and the sheet it came out of is on screen with it", await page.pressOnGlass(alone.phone), true);
  say(`the NPC's own choice, lit: ${alone.label}`);
  await page.shot("hour-p3-an-npc-picks-a-row", { midPress: true });

  // The one thing the press does not win, measured rather than glossed over.
  //
  // A driver's ✅ Listo is answered with three bubbles, the thread scrolls to the
  // newest of them the way `phone.ts` argues it has to, and the button that caused
  // them goes off the top of the glass. That rule has a measurement behind it — top
  // aligning a burst hid the trip card on two of four phones for most of the morning —
  // so the press defers to it. Printed and not asserted: a copy string that shortened
  // the burst by twenty pixels would otherwise turn a non-bug into a red suite.
  const listo = await page.eval<string>("window.__demo.copy.driver.buttons.done");
  const done = await waitFor(
    () =>
      page.stepUntilPressed(
        NARRATED,
        (p) => p.kind === "button" && p.label === listo && DRIVER_PHONES.has(p.phone),
      ),
    `no NPC ever lit ${listo} on a driver's phone`,
  );
  expect("an NPC's ✅ Listo lights the button it was tapped on", done.label, listo);
  const overhang = await page.pressOverhang(done.phone);
  console.log(
    `    …and the three bubbles it is answered with then scroll it ${overhang}px above ` +
      `the glass, which is the thread's rule winning and not the press failing`,
  );

  // And at the fastest speed, in the coarsest frame the clock will believe, which is
  // where a flash tuned against think-times would have vanished. A row again, because
  // a sheet floats over the thread instead of scrolling with it — so this picture is
  // about the speed and nothing else.
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '30×')`);
  const fast = await waitFor(
    () => page.stepUntilPressed(FASTEST, (p) => p.kind === "row"),
    "no press was visible at 30×, in the coarsest frame the clock will believe",
  );
  say(`a press is still up at 30×: ${fast.kind} on ${fast.phone} — ${fast.label}`);
  expect("…and legible, not merely set", await page.pressOnGlass(fast.phone), true);
  expect(
    "…and still one per phone at most, so nothing smears into the next tap",
    await page.litPerPhone(),
    1,
  );
  await page.shot("hour-p4-mid-press-at-30x", { midPress: true });

  expect(
    "the harness can put a press out, which is what makes every other picture here reproducible",
    await page.eval<number>("(window.__demo.clearPresses(), window.__demo.presses().length)"),
    0,
  );
  expect(
    "…and the attribute goes with it",
    await page.eval<number>("document.querySelectorAll('[data-pressed]').length"),
    0,
  );
}

// ── The page without a harness in it ─────────────────────────────────────────

/**
 * The one path every other run here bypasses: no `#probe=1`, no stepping, the
 * hour driven by `requestAnimationFrame` exactly as it is for somebody watching.
 *
 * Deliberately shallow. Headless Chromium has no compositor asking for frames and
 * delivers a couple of callbacks before going quiet, so a whole hour cannot be
 * played this way — which is why the probe exists at all. What it *can* settle is
 * the thing that would otherwise only be reasoned about: that pressing the hour
 * control on an ordinary page builds a world, starts the clock, and gets as far as
 * the scenario's first beat with no probe anywhere in the chain.
 */
async function frameDrivenRun(page: Page): Promise<void> {
  expect(
    "the page boots with no probe on it",
    await page.eval<string>("typeof window.__demo"),
    "undefined",
  );

  await page.click(`document.getElementById('hour')`);
  const first = await waitFor(
    async () => {
      const line = await page.eval<string>(
        `document.querySelector('#ticker-list li')?.textContent ?? ""`,
      );
      return line.includes("Son las nueve") ? line : null;
    },
    "the hour control did nothing on a page driven by its own frame loop",
  );
  say(`the frame loop reaches the first beat: ${first.slice(0, 48)}…`);

  expect(
    "…the clock is running, so ▶ now offers to pause",
    await page.eval<string>("document.getElementById('play').textContent"),
    "Pausa",
  );
  expect(
    "…and the control now offers to run the hour again",
    await page.eval<string>("document.getElementById('hour').textContent"),
    "↻ Repetir la hora",
  );
  await page.shot("hour-e1-no-probe");
}

async function live(page: Page, phone: string): Promise<string> {
  return page.eval<string>(`document.querySelector('.slot[data-phone="${phone}"] .phone').dataset.live`);
}

// ── Comparing two runs ───────────────────────────────────────────────────────

/**
 * Message ids and thread ordinals, removed.
 *
 * They are counters for the life of the page, so an hour started a second time in
 * the same page continues them. Everything else in the trace is a fact about the
 * town and has to match regardless.
 */
function stripCounters(raw: string): string {
  return raw.replace(/"id": "demo\.\d+"/g, '"id": "demo.n"');
}

function diff(label: string, a: string, b: string): void {
  if (a === b) {
    say(`${label} — identical (${a.length} bytes)`);
    return;
  }

  const left = a.split("\n");
  const right = b.split("\n");
  const shown: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length) && shown.length < 24; i += 1) {
    if (left[i] === right[i]) continue;
    shown.push(`    line ${i + 1}\n      first:  ${left[i] ?? "—"}\n      second: ${right[i] ?? "—"}`);
  }
  throw new Error(`FAILED ${label}\n${shown.join("\n")}`);
}

function stamp(at: number | null): string {
  return at === null ? "  —  " : formatSimTime(at) + ":" + String(Math.floor((at - SIM_EPOCH) / 1000) % 60).padStart(2, "0");
}

// ── Building and serving the page ────────────────────────────────────────────

/** Phase 4's, and through `demo/bundle.mjs` for the reason given there. */
function build(): void {
  execFileSync(process.execPath, [join(process.cwd(), "demo", "bundle.mjs"), "page"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  say("the page builds");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
};

/** A 1×1 transparent PNG, served as the favicon so Chromium logs no 404. */
const FAVICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function serveDir(dir: string): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!.split("#")[0]!;
    if (path === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(FAVICON);
      return;
    }
    try {
      const file = readFileSync(join(dir, path === "/" ? "index.html" : path));
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(file);
    } catch {
      res.writeHead(404).end("no");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the demo server did not bind");
  return { port: address.port, close: () => server.close() };
}

// ── The DevTools protocol, by hand ───────────────────────────────────────────

/**
 * Chromium driven over CDP with node's built-in WebSocket and nothing else.
 *
 * Phase 4's driver, unchanged but for the probe methods Phase 5 added. No
 * Puppeteer, because adding it would mean a dependency in `package.json`, and the
 * one thing these phases may not touch is the app's dependencies.
 */
class Browser {
  private nextId = 0;
  private readonly pending = new Map<number, { ok: (value: unknown) => void; bad: (err: Error) => void }>();
  private readonly sessions = new Map<string, Page>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {}

  static async launch(): Promise<Browser> {
    for (const stale of readdirSync(tmpdir())) {
      if (!stale.startsWith("copan-demo-chrome-")) continue;
      try {
        rmSync(join(tmpdir(), stale), { recursive: true, force: true });
      } catch {
        // Chromium's crash handler outlives the browser by a moment and can write
        // into a profile while it is being deleted, which surfaces as ENOTEMPTY.
        // Sweeping /tmp is housekeeping for runs that were killed part-way; failing
        // a whole verification suite over it would be a red build that says nothing
        // about the demo. The next run picks the directory up.
      }
    }

    const profile = join(tmpdir(), `copan-demo-chrome-${process.pid}`);
    mkdirSync(profile, { recursive: true });

    const proc = spawn(
      "chromium",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1920,1080",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    const endpoint = await waitFor(async () => {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }, "chromium never opened a debugging port");

    const ws = new WebSocket(endpoint);
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => bad(new Error("could not attach to chromium")), { once: true });
    });

    const browser = new Browser(ws, proc, profile);
    ws.addEventListener("message", (ev: MessageEvent) => browser.receive(String(ev.data)));
    return browser;
  }

  async open(url: string): Promise<Page> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, String(sessionId));
    this.sessions.set(String(sessionId), page);
    await page.start(url);
    return page;
  }

  async close(): Promise<void> {
    this.ws.close();
    const gone = new Promise<void>((ok) => this.proc.once("exit", () => ok()));
    this.proc.kill();
    await gone;
    rmSync(this.profile, { recursive: true, force: true });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok: ok as (value: unknown) => void, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private receive(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { message: string };
    };

    if (msg.id !== undefined) {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiting) return;
      if (msg.error) waiting.bad(new Error(`${msg.error.message}`));
      else waiting.ok(msg.result);
      return;
    }

    if (msg.method && msg.sessionId) {
      this.sessions.get(msg.sessionId)?.event(msg.method, msg.params ?? {});
    }
  }
}

class Page {
  /** Anything the browser complained about. Zero of these is one of the checks. */
  readonly problems: string[] = [];

  constructor(
    private readonly browser: Browser,
    private readonly sessionId: string,
  ) {}

  async start(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.resize(1920, 1080);
    await this.send("Page.navigate", { url });

    // A page opened without `#probe=1` never grows a `window.__demo`, so booting is
    // waited on through the one thing both kinds of page end up with: four slots on
    // the stage. sql.js compiles its WASM and `loadTown` walks the whole gazetteer
    // before either appears, and neither is instant.
    const probed = url.includes("probe=1");
    await waitFor(
      async () =>
        (await this.eval<number>("document.querySelectorAll('.slot').length")) === 4 &&
        (!probed || (await this.eval<string>("typeof window.__demo")) === "object")
          ? true
          : null,
      "the demo never finished booting",
    );
    if (probed) await this.settle();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.browser.send(method, params, this.sessionId);
  }

  event(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.exceptionThrown") {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        .exceptionDetails;
      this.problems.push(`exception: ${details?.exception?.description ?? details?.text ?? "?"}`);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const call = params as { type?: string; args?: { value?: unknown; description?: string }[] };
      if (call.type !== "error" && call.type !== "warning" && call.type !== "assert") return;
      const said = (call.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ");
      this.problems.push(`console.${call.type}: ${said}`);
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = (params as { entry?: { level?: string; text?: string } }).entry;
      if (entry?.level !== "error" && entry?.level !== "warning") return;
      this.problems.push(`log.${entry.level}: ${entry.text ?? "?"}`);
    }
  }

  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as unknown as {
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error(
        `evaluating ${expression.slice(0, 90)} threw ` +
          `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "?"}`,
      );
    }
    return result.result.value as T;
  }

  /** A real mouse press and release on the middle of whatever the expression finds. */
  async click(finder: string): Promise<void> {
    const spot = await this.eval<{ x: number; y: number } | null>(
      `(() => {
         const el = ${finder};
         if (!el) return null;
         el.scrollIntoView({ block: "center", inline: "center" });
         const r = el.getBoundingClientRect();
         if (r.width === 0 || r.height === 0) return null;
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       })()`,
    );
    if (!spot) throw new Error(`FAILED nothing to click for: ${finder}`);

    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: spot.x,
        y: spot.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  async type(finder: string, text: string): Promise<void> {
    await this.click(finder);
    await this.send("Input.insertText", { text });
  }

  /**
   * A screenshot.
   *
   * Presses are put out first, and that is what makes these pictures reproducible.
   * A press lives on a real-time timer — it has to, being an affordance of the
   * interface rather than an event in the town — so a harness that steps a whole
   * morning through in twenty seconds has no way of knowing whether one happens to
   * be lit when the shutter falls. Rather than shorten the effect until it stopped
   * appearing, the harness ends it deliberately: every picture below shows the page
   * with nothing mid-press, and the two that are *about* a press ask for it by name.
   */
  async shot(name: string, opts: { midPress?: boolean } = {}): Promise<void> {
    // Optional-called, because one page here is opened with no probe on it at all.
    if (!opts.midPress) await this.eval("window.__demo?.clearPresses()");

    const { data } = (await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as unknown as { data: string };
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`  · demo/dist/shots/${name}.png`);
  }

  // ── The page's own probe ───────────────────────────────────────────────────

  async call(method: string, ...args: unknown[]): Promise<void> {
    await this.eval(`window.__demo.${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
  }

  /**
   * Press the hour control, and wait for the hour it builds.
   *
   * The button is clicked rather than `__demo.hour()` being called, because a
   * control nobody presses is a control nobody has tested and this one is the whole
   * of "run the hour". But the handler is `void startHour()` — a click returns
   * before a fresh database, the schema, the seed and `loadTown` are done — and the
   * page freezes its tick loop while the world is being swapped, so stepping into
   * that window would burn sim minutes on ticks that do nothing.
   */
  async startHour(): Promise<void> {
    const before = await this.eval<number>("window.__demo.hours()");
    await this.click(`document.getElementById('hour')`);
    await waitFor(
      async () => ((await this.eval<number>("window.__demo.hours()")) > before ? true : null),
      "the hour control was pressed and no hour was built",
    );
    await this.settle();
  }

  /** Advance the page by whole sim minutes, in fixed steps rather than by waiting. */
  async minutes(count: number, pace: Pace = NARRATED): Promise<void> {
    await this.eval(`window.__demo.step(${pace.stepsPerMinute * count}, ${pace.stepSimMs})`);
  }

  async now(): Promise<number> {
    return this.eval<number>("window.__demo.now()");
  }

  /** The clock face, read off the page rather than computed from a step count. */
  async clockFace(): Promise<string> {
    return this.eval<string>("document.getElementById('clock').textContent");
  }

  /**
   * Whether the page has stopped because the hour is over.
   *
   * Read off the attribute the stylesheet keys on, so the harness is asking the same
   * question the page's own dressing asks and cannot agree with a flag while
   * disagreeing with what a viewer sees.
   */
  async over(): Promise<boolean> {
    return (await this.eval<string>("document.documentElement.dataset.hour")) === "over";
  }

  /**
   * Whether the lit control on this phone is actually where a viewer can see it.
   *
   * "Set on an element" and "on screen" are different claims, and the second is the one
   * the press exists to make. A row lives in a sheet that floats over the thread and is
   * therefore always in view; a reply button lives in the thread and can be scrolled
   * out of it by the reply it caused. Measured against whichever box the control
   * scrolls inside, with a pixel of tolerance for fractional layout.
   */
  async pressOnGlass(phone: string): Promise<boolean> {
    return (await this.pressOverhang(phone)) === 0;
  }

  /**
   * How many pixels of the lit control lie outside the box it scrolls in. Zero is in.
   *
   * A control with no box at all counts as wholly out, and that case is not
   * hypothetical: a sheet that has been closed leaves its rows measuring 0×0 at the
   * origin, which subtracts to zero overhang and would have made this check pass on a
   * highlight nobody could see.
   */
  async pressOverhang(phone: string): Promise<number> {
    return this.eval<number>(
      `(() => {
         const el = document.querySelector('.slot[data-phone="${phone}"] [data-pressed]');
         if (!el) return Number.MAX_SAFE_INTEGER;
         const glass = el.closest('.sheet__body') ?? el.closest('.thread') ?? el.closest('.phone__shell');
         const a = el.getBoundingClientRect();
         const b = glass.getBoundingClientRect();
         if (a.height === 0 || a.width === 0 || b.height === 0) return Number.MAX_SAFE_INTEGER;
         return Math.round(Math.max(0, b.top - a.top) + Math.max(0, a.bottom - b.bottom));
       })()`,
    );
  }

  /** The most `data-pressed` controls on any single phone right now. */
  async litPerPhone(): Promise<number> {
    return this.eval<number>(
      `Math.max(0, ...[...document.querySelectorAll('.phone')]` +
        `.map((p) => p.querySelectorAll('[data-pressed]').length))`,
    );
  }

  async presses(): Promise<Lit[]> {
    return this.eval<Lit[]>("window.__demo.presses()");
  }

  /**
   * Step one tick at a time until a press the caller wants is lit, or give up.
   *
   * A tick at a time, and never a whole minute: a press lasts 450 real milliseconds
   * and a minute is twenty-five ticks the browser runs without pausing, so anything
   * coarser would step straight over the one instant being looked for. Checked *after*
   * each tick, which is where a drain has just delivered whatever it delivered.
   */
  async stepUntilPressed(pace: Pace, wanted: (lit: Lit) => boolean): Promise<Lit | null> {
    for (let tick = 0; tick < 4 * pace.stepsPerMinute; tick += 1) {
      await this.eval(`window.__demo.step(1, ${pace.stepSimMs})`);
      const found = (await this.presses()).find(wanted);
      if (found) return found;
    }
    return null;
  }

  /** Let the queue drain without moving the clock, for a tap just made. */
  async settle(): Promise<void> {
    await this.eval("window.__demo.step(6, 0)");
  }

  async slots(): Promise<SlotView[]> {
    return this.eval<SlotView[]>("window.__demo.slots()");
  }

  async slotOf(phone: string): Promise<SlotView | null> {
    return this.eval<SlotView | null>(`window.__demo.slotOf(${JSON.stringify(phone)})`);
  }

  async ticker(): Promise<string[]> {
    return this.eval<string[]>("window.__demo.ticker()");
  }

  async learned(): Promise<string> {
    return this.eval<string>("window.__demo.learned()");
  }

  async scripted(): Promise<boolean> {
    return this.eval<boolean>("window.__demo.scripted()");
  }

  async trace(): Promise<string> {
    return this.eval<string>("window.__demo.trace()");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor<T>(attempt: () => Promise<T | null>, complaint: string): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    try {
      const value = await attempt();
      if (value !== null && value !== false) return value;
    } catch {
      // Not yet.
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`FAILED ${complaint}`);
}

function has(log: string[], needle: string): boolean {
  return log.some((line) => line.includes(needle));
}

function expect<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`FAILED ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function say(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
