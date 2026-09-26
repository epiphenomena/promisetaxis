/**
 * Wiring, the tick loop, and the control that starts the hour.
 *
 * The demo needs exactly three things the domain does not bring: a database, a
 * clock, and a transport. This file builds those, hands them to four slots, a map,
 * a ticker and the zone-time strip, and then does nothing else — every message on
 * screen, every taxi that moves and every line in the log is `src/domain` reacting
 * to an inbound event.
 *
 * ── Why the world is a value and not a module ─────────────────────────────────
 *
 * "Run the hour" has to mean *from the top*, and identically every time (R4). A
 * page that reset a few counters would drift: the database has the last run's trips
 * in it, the matrix has the last run's learning in it, and the second hour would be
 * a different hour from the first. So everything that holds state lives in one
 * `World` value built from the seed, and starting the hour throws the previous one
 * away and builds another. The sql.js engine and the sim clock are the only things
 * that survive, because neither carries a fact about the town.
 *
 * A world is also built at boot, with no scenario in it. That is the page at rest:
 * four empty slots and a town nobody has hailed from, which is what somebody sees
 * before they press anything — and it is the state a human can poke at with
 * take-control before starting the scripted hour at all.
 */

import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import wasmBase64 from "sql.js/dist/sql-wasm.wasm";

import "./style.css";

import { copy } from "../../src/domain/copy";
import type { InboundPayload } from "../../src/domain/types";
import { formatSimTime, SimClock, SPEEDS } from "./clock";
import type { SqlJsD1Database } from "./d1";
import { openDemoDb } from "./db";
import { Fleet } from "./fleet";
import { TownMap } from "./map";
import { activePresses, clearPresses } from "./press";
import { InboundQueue } from "./queue";
import { createRng, seedFromHash } from "./rng";
import { Scenario } from "./scenario";
import type { SlotView } from "./slots";
import { HumanControl, Names, SlotBoard } from "./slots";
import { Ticker } from "./ticker";
import { loadTown } from "./town";
import { DemoTransport } from "./transport";
import { ZoneTimes } from "./zonetimes";

const el = {
  clock: need("clock"),
  play: need<HTMLButtonElement>("play"),
  hour: need<HTMLButtonElement>("hour"),
  speeds: need("speeds"),
  theme: need<HTMLButtonElement>("theme"),
  seed: need("seed"),
  fault: need("fault"),
  faultHead: need("fault-head"),
  faultDetail: need("fault-detail"),
  drivers: need("col-drivers"),
  customers: need("col-customers"),
  // The column's own stack, not the column: the log sits in the same column below
  // it, so appending to `#col-map` would put the map and the zone-time strip under
  // the log.
  map: need("map-stack"),
  ticker: need("ticker-list"),
};

const clock = new SimClock();

/** Distinguishes the first ▶ from a resume, so the button can say "Empezar" once. */
let started = false;

/**
 * How many scripted hours have been started.
 *
 * Doubles as the hour button's own state — nonzero means it offers to repeat — and
 * as the one thing a harness can watch to know a press has finished taking effect.
 */
let hoursRun = 0;

/**
 * Whether the page is stopped right now, with nothing left to run.
 *
 * Module-level rather than part of the world, because the two controls it silences
 * — ▶ and the speeds — outlive any one world, and the page has to be able to say
 * "there is nothing left to run" without a scenario to ask.
 */
let finished = false;

/**
 * Whether this world's hour has already had its ending.
 *
 * Two flags rather than one, and the difference is the whole of it. `finished` is a
 * state the page can be *released* from: a viewer who takes a phone after the end can
 * hail, and a hail wants a clock. `ended` is a fact about the hour and is never
 * released — without it the very next pump would find the script spent and no trip
 * open, halt again, and hand the viewer live glass with a dead ▶, which is exactly
 * the incoherence the release exists to prevent. So the hour ends once per world, and
 * whatever happens on the page afterwards belongs to whoever is driving it.
 */
let ended = false;

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener("error", (ev) => showFault(ev.error ?? ev.message));
window.addEventListener("unhandledrejection", (ev) => showFault(ev.reason));

const seed = seedFromHash(window.location.hash);
el.seed.textContent = `semilla ${seed}`;
// It looks like a debugging leftover and it is the opposite: the number is the
// reason the hour is the same hour every time it is shown (R4), which is worth
// saying to anybody who hovers over it rather than leaving as a bare figure.
el.seed.title =
  `La hora entera — quién escribe, a qué minuto, y cuánto tarda cada viaje — sale ` +
  `de este número. Con la misma semilla, la misma hora.`;

void boot().catch(showFault);

// ── The world ────────────────────────────────────────────────────────────────

type World = {
  db: SqlJsD1Database;
  queue: InboundQueue;
  transport: DemoTransport;
  fleet: Fleet;
  map: TownMap;
  learn: ZoneTimes;
  board: SlotBoard;
  ticker: Ticker;
  scenario: Scenario | null;
  dispose(): void;
};

/**
 * Everything, from the seed.
 *
 * The two PRNG streams are the subtle part. The fleet's jitter and the cast's
 * think-times both come from the seed, but from *separate* generators: one shared
 * stream would mean that taking control of a phone — which stops that NPC drawing
 * think-times — shifted every later trip's duration, so the same seeded hour would
 * look different depending on whether anybody had touched the page.
 */
async function buildWorld(SQL: SqlJsStatic, opts: { scripted: boolean }): Promise<World> {
  const db = openDemoDb(SQL);

  const transport = new DemoTransport(() => clock.now());
  const queue = new InboundQueue(db, transport, showFault);

  // `loadTown` asserts the map can draw and reach every place in the gazetteer
  // before anything moves. A landmark with no road to it would otherwise surface
  // as a taxi that accepts a trip and never arrives, halfway through a demo.
  const town = await loadTown(db);
  const fleet = new Fleet(db, town, createRng(seed));
  const map = new TownMap(town);

  const names = new Names();
  const control = new HumanControl();
  const ticker = new Ticker({ db, queue, transport, fleet, names, list: el.ticker });
  const learn = new ZoneTimes({ db, note: (at, text) => ticker.note(at, "beat", text) });
  el.map.append(map.el, learn.el);

  const board = new SlotBoard(
    {
      db,
      clock,
      queue,
      transport,
      names,
      control,
      note: (at, kind, text) => ticker.note(at, kind, text),
    },
    { drivers: el.drivers, customers: el.customers },
  );

  // Who is driving a phone is the one thing on this page the domain cannot know,
  // so it reaches the log through the same seam the scripted beats use.
  control.onChange(({ phone, human, at }) => {
    // Taking a phone once the hour has ended is the one thing that can give a
    // stopped page something to run again: a person can hail, and a hail wants a
    // clock and a taxi that moves. So the finished state is released rather than
    // argued with. The closing line stays in the log, because it is still true of
    // the hour; ▶ is simply live again for whoever wants to watch what they start.
    if (human) reopenHour();
    ticker.note(
      at,
      "control",
      // No adjective and no pronoun that has to agree: the cast is named by
      // whoever writes the scenario, and "toque por él" about a Carla is the kind
      // of slip that makes a Spanish-speaking audience distrust the rest of the
      // Spanish on the page.
      human
        ? `Usted tomó el control del teléfono de ${names.of(phone)}: escriba y toque en su lugar.`
        : `Usted devolvió el teléfono de ${names.of(phone)}.`,
    );
  });

  const scenario = opts.scripted
    ? new Scenario({
        db,
        queue,
        transport,
        control,
        fleet,
        board,
        note: (at, kind, text) => ticker.note(at, kind, text),
        // Offset from the same seed rather than seeded separately, so `#seed=42`
        // still names one hour. The constant is arbitrary; only its fixedness
        // matters.
        rng: createRng((seed ^ 0x5bf0_3635) >>> 0),
      })
    : null;

  // The NPCs have to be reachable before the first tap, because taking control of
  // a phone is what suspends one and a viewer may do that at 09:00.
  if (scenario) control.register(scenario.directory);

  await learn.observe(clock.now());
  await fleet.sync(clock.now());
  map.render(fleet.sample(clock.now()));

  return {
    db,
    queue,
    transport,
    fleet,
    map,
    learn,
    board,
    ticker,
    scenario,
    dispose(): void {
      scenario?.dispose();
      board.dispose();
      ticker.dispose();
      map.el.remove();
      learn.el.remove();
      // Last, and only after everything that might still read a row is detached:
      // the statements live in the WASM heap, and a demo left open all afternoon
      // through a dozen restarts would otherwise grow one database per press.
      db.close();
    },
  };
}

async function boot(): Promise<void> {
  const SQL = await initSqlJs({ wasmBinary: base64ToBytes(wasmBase64) });

  let world = await buildWorld(SQL, { scripted: false });

  /**
   * True while the world is being swapped.
   *
   * The button's handler runs between two of `pump`'s awaits, so without this a
   * drain begun against the old database would finish by refreshing slots that
   * belong to the new one.
   */
  let switching = false;

  async function startHour(): Promise<void> {
    if (switching) return;
    switching = true;
    try {
      clock.pause();
      // Before the world is built, not after: `fleet.sync` reads the clock, and a
      // fleet planned at 09:47 and then shown 09:00 would park every sprite
      // mid-street until the hour caught up with it.
      clock.reset();
      // And the old world goes before the new one arrives, not after. They share
      // three containers on the page — the two phone columns and the log — and a
      // teardown that ran second would take the new hour's first lines with it.
      world.dispose();
      world = await buildWorld(SQL, { scripted: true });
    } finally {
      switching = false;
    }
    hoursRun += 1;
    finished = false;
    ended = false;
    // Read by `style.css` to drop "press 🎬 to start the hour" from the empty slots,
    // and by `= "over"` below to dress the page once the hour has ended. An empty
    // slot is the ordinary state once the hour is running, and the page should not
    // keep asking for something it already has.
    document.documentElement.dataset.hour = "running";
    clock.play();
    paintPlay();
    paintHour();
    paintSpeeds();
    paintClock();
  }

  wireControls(startHour);
  paintClock();

  /**
   * Drains are awaited and a single delivery is many D1 round-trips, so at 12×
   * the next frame reliably arrives before the last one finished. Overlapping
   * pumps would refresh a header from a half-applied conversation.
   */
  let pumping = false;

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    // Captured rather than read twice: the hour can be restarted between any two
    // awaits below, and finishing this pass against a mixture of two worlds is
    // the one failure that would present as a phone showing another run's thread.
    const mine = world;
    try {
      // Before the drain: a beat and an NPC both do exactly one thing, which is
      // put an event on the queue, and an event enqueued here is due now.
      await mine.scenario?.tick(clock.now());
      if (mine !== world) return;

      const result = await mine.queue.drain(clock.now());
      if (mine !== world) return;

      // `handleInbound` and the sweep are the only things that can change a row,
      // and both just ran — so this is exhaustive, where re-reading every frame
      // would be a query per phone at 60 Hz for nothing.
      if (result.delivered > 0 || result.swept) {
        // Strictly before `fleet.sync`. A trip that just closed is still on the
        // fleet's plan at this instant, and that plan is the only witness to
        // whether the sprite had arrived — which is the whole of §8's early-✅
        // Listo line. After the sync the drive is gone.
        await mine.ticker.observe(clock.now());
        if (mine !== world) return;
        await mine.learn.observe(clock.now());
        if (mine !== world) return;
        await mine.board.observe(clock.now());
        if (mine !== world) return;
        await mine.fleet.sync(clock.now());
      }

      if (mine !== world) return;
      await stopIfOver(mine, () => mine === world);
    } catch (err) {
      showFault(err);
    } finally {
      pumping = false;
    }
  }

  /**
   * One tick: move the clock, redraw, deliver whatever came due.
   *
   * Split out from the frame callback so a fixed step can drive the same tick.
   * Everything it touches — the sim clock, the queue, the fleet — is a function of
   * the sim instant, so a page stepped by hand and a page driven by frames pass
   * through exactly the same states.
   *
   * The queue is drained whether or not the clock is running: paused means time is
   * frozen, not that the page stopped listening, so a tap while paused still lands
   * and is stamped with the minute on screen.
   */
  async function tick(realMs: number): Promise<void> {
    if (switching) return;
    clock.advance(realMs);
    paintClock();
    // Sampled every tick while the fleet is only re-read after a drain: the
    // positions are a pure function of sim time, so this costs a handful of
    // attribute writes and nothing else. It is also what announces a finished leg,
    // which is what prompts a driver to tap ✅ Listo (R2).
    world.map.render(world.fleet.sample(clock.now()));
    await pump();
  }

  /**
   * Whether the clock has been handed to a harness stepping it by hand.
   *
   * Set by the first `__demo.step()` and never cleared. The frame loop turns into a
   * no-op from then on, because the two cannot share the clock: a browser frame
   * contributes however many real milliseconds happened to pass, so an hour driven by
   * fixed steps *and* by frames advances by 2400 ms plus whatever the machine was
   * doing — and R4's claim, that the same schedule gives the same hour down to the
   * millisecond, would be false for a reason that has nothing to do with the demo.
   * Stepping is strictly more faithful to R4 than the frame loop is; it is only the
   * frame loop that exists, because a page has to animate for somebody watching it.
   */
  let stepped = false;

  exposeProbe({
    clock,
    tick,
    startHour,
    world: () => world,
    list: el.ticker,
    takeClock: () => {
      stepped = true;
    },
    hours: () => hoursRun,
  });

  /**
   * The rAF timestamp is the only real-time reading in the demo, and it becomes
   * sim time immediately (R4).
   */
  let previous: number | null = null;

  function frame(timestamp: number): void {
    const elapsed = previous === null ? 0 : timestamp - previous;
    previous = timestamp;
    if (!stepped) void tick(elapsed);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

// ── The end of the hour ──────────────────────────────────────────────────────

/**
 * Stop, once there is nothing left to run.
 *
 * The end of the hour is deliberately not a clock reading. Cutting at 10:00 would
 * sooner or later freeze a taxi halfway to a passenger who is still standing on the
 * corner, which is a strange note to end a presentation on — so the test is one the
 * town can answer: the script has run out and nobody is mid-thought
 * (`Scenario.scripted`), *and* no trip is still open. Both have to hold, and the
 * second is asked of `trips` rather than of a tally the demo kept as it went (R2).
 *
 * Halting is three things and no more: the clock stops, which stops the taxis too
 * because a sprite's position is a pure function of the sim instant; the page is
 * marked so the stylesheet can dress it; and ▶ and the speeds go dead, because a
 * speed control on a page with nothing left to play is a control that lies.
 *
 * Called from `pump`, after the observe-and-sync pass and never from inside it. The
 * extra `SELECT` therefore cannot land between one of the domain's writes and the
 * `meta.changes` read that follows it, which is the shim failure §6 of the plan
 * warns about; and it only runs at all in the handful of frames where the scenario
 * already believes it is spent.
 *
 * `current` is the same guard every other await in `pump` carries: the hour can be
 * restarted between any two of them, and a closing line written after that would land
 * at the top of the new hour's log.
 */
async function stopIfOver(mine: World, current: () => boolean): Promise<void> {
  if (finished || ended) return;
  if (!(mine.scenario?.scripted ?? false)) return;

  const open = await mine.db
    .prepare("SELECT COUNT(*) AS n FROM trips WHERE state IN ('pending','assigned','on_trip')")
    .first<{ n: number }>();
  if (!current()) return;
  if ((open?.n ?? 0) > 0) return;

  finished = true;
  ended = true;
  const at = clock.now();
  clock.pause();
  document.documentElement.dataset.hour = "over";

  // Stamped with the instant the clock froze at, which is the latest thing that has
  // happened: the log reads downwards and a closing line dated from anything else
  // would sit above lines older than itself.
  await mine.ticker.closing(at);

  paintPlay();
  paintSpeeds();
}

/** See the note in `buildWorld`: a person with a phone has something to run. */
function reopenHour(): void {
  if (!finished) return;
  finished = false;
  document.documentElement.dataset.hour = "running";
  paintPlay();
  paintSpeeds();
}

// ── Controls ─────────────────────────────────────────────────────────────────

function wireControls(startHour: () => Promise<void>): void {
  el.hour.addEventListener("click", () => {
    void startHour().catch(showFault);
  });

  el.play.addEventListener("click", () => {
    clock.toggle();
    paintPlay();
  });

  for (const speed of SPEEDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${speed}×`;
    btn.dataset.speed = String(speed);
    // "12×" says nothing to somebody who has not been told what one × is.
    btn.title = `Un minuto del pueblo cada ${60 / speed} segundos.`;
    btn.addEventListener("click", () => {
      clock.setSpeed(speed);
      paintSpeeds();
    });
    el.speeds.append(btn);
  }

  el.theme.addEventListener("click", () => {
    // Written as an explicit choice rather than a class toggle, because the dark
    // tokens are keyed on `[data-theme]` as well as on the media query — that is
    // what lets a viewer override the setting their machine came with.
    document.documentElement.dataset.theme = showingDark() ? "light" : "dark";
    paintTheme();
  });

  paintPlay();
  paintHour();
  paintSpeeds();
  paintTheme();
}

/**
 * The clock control.
 *
 * Its resting word is "Correr el reloj" and not "Empezar", because the button
 * beside it says "🎬 Empezar la hora" and two controls offering to start something
 * is how a viewer presses the wrong one and concludes the page is broken. This one
 * only ever moves time; the other one is the hour.
 */
function paintPlay(): void {
  const running = clock.isRunning();
  if (running) started = true;
  el.play.setAttribute("aria-pressed", String(running));
  el.play.textContent = running ? "Pausa" : started ? "Seguir" : "Correr el reloj";
  // Dead once the hour is over, along with the speeds. A clock that still offers to
  // run when every viaje is closed and every beat has played would move the hands
  // over an empty town, and a viewer who pressed it would conclude the page had
  // frozen — the opposite of what actually happened.
  el.play.disabled = finished;
  el.play.title = finished
    ? "La hora terminó: ya no queda nada por correr. Pulse ↻ Repetir la hora."
    : running
      ? "Detiene el reloj para leer con calma; lo que usted toque llega igual."
      : "Mueve el reloj del pueblo. No empieza la hora: eso es el botón de al lado.";
}

function paintHour(): void {
  el.hour.textContent = hoursRun > 0 ? "↻ Repetir la hora" : "🎬 Empezar la hora";
  el.hour.title = hoursRun > 0
    ? "Vuelve a las nueve de la mañana y corre la misma hora otra vez, igual que la primera."
    : "Corre la hora completa: los clientes, los conductores y todo lo que el sistema decide.";
}

function paintSpeeds(): void {
  for (const btn of el.speeds.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.speed === String(clock.currentSpeed())));
    // The chosen speed stays marked while the hour is over, because it is still the
    // speed the next run will start at — it simply cannot be changed from a page
    // that has nothing left to play at any speed.
    btn.disabled = finished;
  }
}

function paintTheme(): void {
  const dark = showingDark();
  el.theme.textContent = dark ? "Claro" : "Oscuro";
  // The word on the button is where it goes, not where it is, which is ambiguous
  // enough on its own that the sentence has to say so.
  el.theme.title = dark ? "Cambiar a fondo claro." : "Cambiar a fondo oscuro.";
}

function paintClock(): void {
  const face = formatSimTime(clock.now());
  // Guarded because this runs 60 times a second while the face changes once a sim
  // minute; writing regardless would dirty the layout on every frame.
  if (el.clock.textContent !== face) el.clock.textContent = face;
}

/** Whichever theme the page is actually showing, OS preference included. */
function showingDark(): boolean {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "dark") return true;
  if (chosen === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// ── The verification hook ────────────────────────────────────────────────────

/**
 * What a headless browser is allowed to do to this page, and nothing more.
 *
 * Two things make verification impossible without it. Headless Chromium delivers
 * two `requestAnimationFrame` callbacks and then stops — there is no compositor
 * asking for frames — so a page whose clock is driven by frames never moves and a
 * screenshot of a drive cannot be taken. And the slots only exist in response to
 * traffic, so there has to be a way to produce traffic without the scripted hour.
 *
 * It is not a back door. `push` is `queue.push` and nothing else — the same call a
 * thumb on the glass makes (R1) — `step` is the same `tick` the frame loop calls,
 * `hour` is the same function the button calls, and none of them appears unless
 * `#probe=1` asks for it. Everything else it offers is read-only.
 *
 * Defined once, at boot, and everything it reads goes through `world()`. The
 * property is not configurable, so a second `Object.defineProperty` after a
 * restart would throw — and a probe that had captured the first world would
 * silently report on a database nobody is looking at.
 */
type Probe = {
  now(): number;
  push(from: string, payload: InboundPayload, delaySimMs?: number): void;
  step(steps: number, simMsPerStep?: number): Promise<string>;
  /** The real hour control, so a harness drives what a viewer drives. */
  hour(): Promise<void>;
  /**
   * How many scripted hours have finished being built.
   *
   * The hour button is a click and building a world is asynchronous — a fresh sql.js
   * database, the schema, the seed and `loadTown` — so between the press and the
   * first beat there is a stretch in which the page is deliberately frozen. A
   * harness that started stepping into it would spend its first sim minute on ticks
   * that do nothing. A count rather than a flag, because starting the hour *again*
   * has to be distinguishable from an hour already running.
   */
  hours(): number;
  /** Whether the script has run out and nobody is mid-thought. */
  scripted(): boolean;
  /**
   * The controls lit as pressed at this instant, and the way to put them out.
   *
   * Both halves are here for the same reason: a press is the one thing on this page
   * that lives on a real-time timer, so a harness stepping a whole morning through in
   * twenty seconds cannot know whether one is up when it takes a picture. `presses()`
   * is how the mid-press screenshots are *asserted* rather than hoped for, and
   * `clearPresses()` is how every other screenshot is made to say one thing —
   * deterministic in both directions, with the effect itself untouched.
   *
   * Neither can put an event into the system or take one out, which is why they are
   * allowed to be here at all.
   */
  presses(): { phone: string; kind: string; label: string }[];
  clearPresses(): void;
  identify(phone: string, name: string): void;
  slots(): SlotView[];
  slotOf(phone: string): SlotView | null;
  ticker(): string[];
  /** The zone-time strip, as the line it shows. */
  learned(): string;
  /** Everything a determinism check compares, as JSON. */
  trace(): Promise<string>;
  /** The driver's own words for ✅ Listo, so a harness never hardcodes the copy. */
  copy: typeof copy;
};

/**
 * Sim milliseconds per step when a caller does not say.
 *
 * Both harnesses pass their own — a whole sim minute has to divide into a whole
 * number of steps for a screenshot to land on the minute it claims — so this is
 * only the default for a hand-typed `__demo.step(10)` in a console. 200 ms is one
 * frame's worth at the speed the page opens on.
 */
const STEP_SIM_MS = 200;

function exposeProbe(parts: {
  clock: SimClock;
  tick: (realMs: number) => Promise<void>;
  startHour: () => Promise<void>;
  world: () => World;
  list: HTMLElement;
  /** Stop the frame loop advancing the clock; see `stepped` in `boot`. */
  takeClock: () => void;
  /** How many scripted hours have finished being built. */
  hours: () => number;
}): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (params.get("probe") !== "1") return;

  const probe: Probe = {
    now: () => parts.clock.now(),

    push(from, payload, delaySimMs = 0) {
      parts.world().queue.push(parts.clock.now() + delaySimMs, from, payload);
    },

    async step(steps, simMsPerStep = STEP_SIM_MS) {
      // Stepped rather than waited on: it reads no wall clock at all, so it is if
      // anything more faithful to R4 than the frame loop is, and "screenshot the
      // taxi at sim-minute five" becomes exact rather than a matter of catching
      // the browser at the right moment.
      parts.takeClock();
      const realMs = simMsPerStep / parts.clock.currentSpeed();
      for (let i = 0; i < steps; i += 1) await parts.tick(realMs);
      return formatSimTime(parts.clock.now());
    },

    hour: () => parts.startHour(),
    hours: () => parts.hours(),
    scripted: () => parts.world().scenario?.scripted ?? false,
    presses: () => activePresses(),
    clearPresses: () => clearPresses(),

    identify: (phone, name) => parts.world().board.identify(phone, name),
    slots: () => parts.world().board.snapshot(),
    slotOf: (phone) => parts.world().board.viewOf(phone),
    learned: () => parts.world().learn.text(),
    // The timestamp and the text are separate elements held apart by a gap, so
    // `textContent` would run them together into "09:01Asignado".
    ticker: () =>
      [...parts.list.querySelectorAll("li")].map((li) =>
        [...li.childNodes]
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    trace: () => trace(parts.world(), parts.clock, parts.list),
    copy,
  };

  Object.defineProperty(window, "__demo", { value: probe });
}

/**
 * The hour as data, for comparing two runs of it.
 *
 * Deliberately three kinds of thing. The inbound log is what went in; the tables
 * are what the domain made of it; the ticker and the strip are what a viewer was
 * told. A demo that replayed identically in the database while printing different
 * lines would still have failed R4, and only the third kind catches that.
 */
async function trace(world: World, simClock: SimClock, list: HTMLElement): Promise<string> {
  const rows = async (sql: string): Promise<unknown[]> =>
    (await world.db.prepare(sql).all()).results;

  return JSON.stringify(
    {
      seed,
      now: simClock.now(),
      inbound: world.queue.delivered.map((d) => ({
        id: d.event.messageId,
        at: d.event.at,
        from: d.event.from,
        payload: d.event.payload,
      })),
      outbound: world.transport.sent.map((s) => ({
        at: s.at,
        to: s.to,
        kind: s.message.spec.kind,
        body: "body" in s.message.spec ? s.message.spec.body : null,
      })),
      // `approach_min` earns its place here: it is the term `learnZoneTime`
      // subtracts, so it is what lets a harness show both what the matrix learned
      // and what it would have learned without the subtraction — the same hour, the
      // same jitter, one variable. Without it the only comparison available is
      // against a number measured on a different run by different code.
      trips: await rows(
        `SELECT id, source, customer_phone, pickup_zone_id, dest_zone_id, dest_label,
                driver_id, state, quoted_wait_min, approach_min, requested_at,
                assigned_at, done_at, canceled_reason
           FROM trips ORDER BY id`,
      ),
      drivers: await rows(
        `SELECT id, phone, status, zone_id, projected_zone_id, available_at, idle_since
           FROM drivers ORDER BY id`,
      ),
      zoneTimes: await rows(
        `SELECT from_zone, to_zone, ROUND(minutes, 6) AS minutes, samples FROM zone_times
          WHERE samples > 0 ORDER BY from_zone, to_zone`,
      ),
      statusEvents: await rows(
        "SELECT driver_id, status, zone_id, at FROM status_events ORDER BY id",
      ),
      sessions: await rows("SELECT phone, role, state FROM sessions ORDER BY phone"),
      ticker: [...list.querySelectorAll("li")].map((li) =>
        [...li.childNodes]
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
      learned: world.learn.text(),
    },
    null,
    1,
  );
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

function showFault(err: unknown): void {
  el.fault.hidden = false;
  // The headline is the app's own words for a fault; the detail is for us.
  el.faultHead.textContent = copy.common.error;
  el.faultDetail.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(err);
}

/**
 * The sql.js WASM arrives inlined as base64 rather than fetched.
 *
 * Not an optimisation: on `file://` a request for a sibling `.wasm` is blocked
 * outright, so handing the bytes to `initSqlJs` directly is the only way Phase
 * 6's double-click story can work. Doing it in dev as well means the handout and
 * the dev server load the engine the same way, so a WASM problem cannot appear
 * for the first time in the thing being handed out.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function need<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`demo: index.html is missing #${id}`);
  return found as T;
}
