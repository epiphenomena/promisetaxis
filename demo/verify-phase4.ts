/**
 * Phase 4's proof: the four slots hold the right conversations, a person can drive
 * either role, and R5 is load-bearing rather than decorative.
 *
 * Unlike phases 1 and 3, this cannot be settled in node. Slots are DOM, take-control
 * is a click, and the failure modes the phase is actually at risk of — a slot that
 * adopts a conversation and shows an empty thread, a button that looks live and
 * isn't, a column that clips — only exist in a browser. So this drives a real
 * Chromium over the DevTools protocol: it presses ▶ and the theme button, clicks
 * 🎮, taps ✅ Listo inside the phone, types into the composer, and takes
 * screenshots to be looked at afterwards.
 *
 * The day it drives is chosen to construct one situation, because that situation is
 * the only reason R5 exists:
 *
 *   1. Ana hails and Don José takes it            — one driver busy, one customer slot
 *   2. Marvin taps ✋ Bandera                     — a second driver busy, and a
 *                                                   bandera has no customer phone, so
 *                                                   it costs no customer slot
 *   3. Doña Rosa taps ☕ Descanso                 — the third driver out of the pool,
 *                                                   and refused a driver slot
 *   4. Beto hails                                 — nobody `available`, so the trip
 *                                                   stays pending and he reads
 *                                                   `copy.customer.queued`
 *   5. four quiet minutes, then Carla writes      — refused a slot, because both
 *                                                   customer slots are held
 *   6. Don José taps ✅ Listo                     — `offerNextTrip` claims Beto's
 *                                                   trip and Beto finally gets
 *                                                   `driverOnWay`, five sim-minutes
 *                                                   after he went quiet
 *
 * Then the same day is driven again against a built copy of the page with R5
 * excised — a regex over the bundle, asserted to have matched exactly once — and
 * the beat is shown to be lost: at the instant the driver taps, the queued customer
 * is not on screen at all.
 *
 * Run it with `npm run demo:verify:slots`. The screenshots land in
 * `demo/dist/shots/` and still have to be looked at; this only proves the parts a
 * pair of eyes cannot.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { formatSimTime } from "./src/clock";

// ── The cast ─────────────────────────────────────────────────────────────────

const JOSE = "50499990001";
const MARVIN = "50499990002";
const ROSA = "50499990003";

const ANA = "50488880001";
const BETO = "50488880002";
const CARLA = "50488880003";

/** Seeded landmarks, with the titles WhatsApp would echo back on a tap. */
const PLACES = {
  parque: { id: "parque_central", name: "Parque Central", lat: 14.8397, lng: -89.1531 },
  marina: { id: "hotel_marina", name: "Hotel Marina Copán", lat: 14.8399, lng: -89.1528 },
  terminal: { id: "terminal", name: "Terminal de buses", lat: 14.8389, lng: -89.1543 },
  mercado: { id: "mercado", name: "Mercado", lat: 14.8393, lng: -89.1538 },
  estadio: { id: "estadio", name: "Estadio", lat: 14.8365, lng: -89.1552 },
  mirador: { id: "mirador", name: "El Mirador", lat: 14.8438, lng: -89.1552 },
  parqueArq: { id: "parque_arq", name: "Parque Arqueológico", lat: 14.84, lng: -89.1417 },
} as const;

const ZONES = {
  centro: { id: "centro", name: "Centro" },
  ruinas: { id: "ruinas", name: "Las Ruinas" },
  abajo: { id: "barrio_abajo", name: "Barrio abajo" },
} as const;

/**
 * Sim milliseconds per fixed step, and steps per sim minute.
 *
 * `SimClock` clamps a frame at 250 ms of real time before multiplying by the speed,
 * so 12× is 3000 sim ms per tick at the very edge of the clamp. 2400 sits inside it
 * with room to spare, and 25 of them is exactly one sim minute.
 */
const STEP_SIM_MS = 2400;
const STEPS_PER_MINUTE = 25;

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

type Payload =
  | { kind: "text"; text: string }
  | { kind: "location"; lat: number; lng: number }
  | { kind: "button"; id: string; title: string }
  | { kind: "list"; id: string; title: string };

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  build();
  mkdirSync(SHOTS, { recursive: true });

  const honest = await serveDir(join(process.cwd(), "demo"));
  const scratchDir = breakR5();
  const broken = await serveDir(scratchDir);
  const browser = await Browser.launch();

  try {
    console.log("\n  ── The page as it ships ──────────────────────────────────\n");
    const page = await browser.open(`http://127.0.0.1:${honest.port}/index.html#probe=1`);
    const kept = await runDay(page, { claims: true, shots: true });

    console.log("\n  ── The same day with R5 excised ──────────────────────────\n");
    const scratch = await browser.open(`http://127.0.0.1:${broken.port}/index.html#probe=1`);
    const lost = await runDay(scratch, { claims: false, shots: false });

    console.log("\n  ── R5, as a difference ───────────────────────────────────\n");
    report(kept, lost);

    const noise = [...page.problems, ...scratch.problems];
    if (noise.length > 0) {
      throw new Error(`FAILED the browser logged ${noise.length} problem(s):\n  ${noise.join("\n  ")}`);
    }
    say("neither page logged a console error, a warning or an exception");

    console.log(`\n${checks} checks passed. Screenshots in demo/dist/shots — look at them.\n`);
  } finally {
    await browser.close();
    honest.close();
    broken.close();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ── The day ──────────────────────────────────────────────────────────────────

type DayResult = {
  /** Beto's slot at the instant before the driver taps ✅ Listo. */
  before: SlotView | null;
  /** And immediately after, which is when `driverOnWay` reaches him. */
  after: SlotView | null;
  ticker: string[];
};

/**
 * The day, driven twice.
 *
 * `claims` is what differs between the two runs. The beats — every `push`, every
 * step of the clock — are shared, because the whole argument rests on the two runs
 * being the same day: if the traffic drifted apart, the difference in the outcome
 * would prove nothing. The second run makes no assertions because almost none of
 * them hold with R5 gone, which is the point, and it taps ✅ Listo by pushing the
 * event rather than by clicking, because without retention Doña Rosa has taken Don
 * José's slot by 09:04 and there is no phone on screen to click.
 */
async function runDay(
  page: Page,
  opts: { claims: boolean; shots: boolean; prefix?: string },
): Promise<DayResult> {
  const shot = async (name: string): Promise<void> => {
    if (opts.shots) await page.shot(`${opts.prefix ?? ""}${name}`);
  };

  // Named before they say anything: a slot takes its label at adoption, which is
  // the same instant the first message lands.
  await page.call("identify", ANA, "Ana");
  await page.call("identify", BETO, "Beto");
  await page.call("identify", CARLA, "Carla");

  // ── The page at rest ──────────────────────────────────────────────────────
  if (opts.claims) {
    const resting = await page.slots();
    expect("four slots before anything happens", resting.length, 4);
    expect("two of them for conductores", resting.filter((s) => s.role === "driver").length, 2);
    expect("two for clientes", resting.filter((s) => s.role === "customer").length, 2);
    expect("all four empty", resting.every((s) => s.phone === null), true);
    expect(
      "each empty slot says what will appear in it",
      await page.eval<number>("document.querySelectorAll('.slot__empty-note').length"),
      4,
    );
    expect(
      "the ticker says nothing has happened yet",
      (await page.ticker())[0]?.includes("Todavía no ha pasado nada"),
      true,
    );
    await shot("01-rest-light");

    await page.click(`document.getElementById('theme')`);
    expect(
      "the theme button switches the page to dark",
      await page.eval<string>("document.documentElement.dataset.theme"),
      "dark",
    );
    await shot("02-rest-dark");
    await page.click(`document.getElementById('theme')`);
  }

  // 12× first so one fixed step per frame covers a sim minute in 25 of them, then
  // ▶ — both by clicking the real controls, because a control nobody presses is a
  // control nobody has tested.
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '12×')`);
  await page.click(`document.getElementById('play')`);
  if (opts.claims) {
    expect("▶ starts the clock", await page.eval<string>("document.getElementById('play').textContent"), "Pausa");
  }

  // ── 09:00 two drivers start their shift ───────────────────────────────────
  await page.push(JOSE, { kind: "location", lat: PLACES.parque.lat, lng: PLACES.parque.lng });
  await page.push(MARVIN, { kind: "location", lat: PLACES.estadio.lat, lng: PLACES.estadio.lng }, 3000);
  await page.minutes(1);

  if (opts.claims) {
    expect("Don José's shift-start pin got him a driver slot", (await page.slotOf(JOSE))?.role, "driver");
    expect("…and Marvin the other one", (await page.slotOf(MARVIN))?.role, "driver");
    expect("Doña Rosa, who has said nothing, is on nobody's screen", await page.slotOf(ROSA), null);
    expect(
      "a driver's opening pin is in the log, with the zone it resolved to",
      only(await page.ticker(), "Don José (#3) entró en turno"),
      "09:00 Don José (#3) entró en turno y mandó su ubicación 📍: está por Centro.",
    );
  }

  // ── 09:01 Ana hails, and is assigned on the spot ──────────────────────────
  await hail(page, ANA, PLACES.marina, ZONES.ruinas, PLACES.parqueArq);
  await page.minutes(1);

  if (opts.claims) {
    const ana = await page.slotOf(ANA);
    expect("Ana's first message got her a customer slot", ana?.label, "Ana");
    expect("…showing the conversation from its greeting", ana?.thread.some((m) => m.includes("Somos el servicio")), true);
    expect("…and the slot is held while her trip is open", ana?.retained, true);
    expect("…with the phone itself dead to the touch", await live(page, ANA), "false");
    expect(
      "the ticker names the driver and the quote",
      only(await page.ticker(), "Asignado"),
      "09:01 Asignado: Don José (#3) · 3 min.",
    );
  }

  // ── 09:02 Marvin is flagged down in the street ────────────────────────────
  await page.push(MARVIN, { kind: "button", id: "drv:bandera", title: "✋ Bandera" });
  await page.push(MARVIN, { kind: "list", id: `bzone:${ZONES.ruinas.id}`, title: ZONES.ruinas.name }, 4000);
  await page.minutes(1);

  if (opts.claims) {
    expect("Marvin's bandera holds his slot", (await page.slotOf(MARVIN))?.word, "Con viaje abierto");
    expect(
      "a bandera puts no 👤 on the map, having no customer to draw",
      await page.eval<number>("document.querySelectorAll('.map__customers .wait').length"),
      1,
    );
  }

  // ── 09:03 …and asks for a break he cannot have ────────────────────────────
  await page.push(MARVIN, { kind: "button", id: "drv:break", title: "☕ Descanso" });
  await page.minutes(1);

  if (opts.claims) {
    expect(
      "the refusal reaches the log, though it changed no row",
      (await page.ticker()).some((l) => l.includes("pidió descanso con un viaje abierto")),
      true,
    );
  }

  // ── 09:04 Doña Rosa takes her break, and finds no slot ────────────────────
  await page.push(ROSA, { kind: "button", id: "drv:break", title: "☕ Descanso" });
  await page.minutes(1);

  if (opts.claims) {
    expect(
      "Doña Rosa is on break, which the domain's own audit log reports",
      only(await page.ticker(), "se fue a descansar"),
      "09:04 Doña Rosa (#11) se fue a descansar ☕.",
    );
    expect("…and she is on nobody's screen, both driver slots being held", await page.slotOf(ROSA), null);
    expect(
      "the log says so rather than leaving her unexplained",
      (await page.ticker()).some((l) => l.includes("Doña Rosa") && l.includes("de conductores")),
      true,
    );
    await shot("03-fleet-busy");
  }

  // ── 09:05 Beto hails with nobody free ─────────────────────────────────────
  await hail(page, BETO, PLACES.terminal, ZONES.abajo, PLACES.estadio);
  await page.minutes(1);

  if (opts.claims) {
    const beto = await page.slotOf(BETO);
    const quote = beto?.thread.find((m) => m.includes("Anotado")) ?? "";
    expect("Beto is told he is on the list", quote.includes("Anotado"), true);
    expect("…with a number, taken from a driver who is not free yet", /\d+ minutos/.test(quote), true);
    expect("…and his slot is held", beto?.retained, true);
    expect("his slot took him on at 09:05", stamp(beto?.adoptedAt ?? 0), "09:05");
    expect(
      "the log has the queue, without inventing the minutes",
      only(await page.ticker(), "queda en la lista"),
      "09:05 Ningún tuktuk libre: Beto queda en la lista.",
    );
  }

  // ── 09:07 Ana asks whether it is coming ───────────────────────────────────
  // Deliberate, and load-bearing for the comparison: it makes Ana the *more*
  // recently active conversation, so a policy of "evict whoever has been quiet
  // longest" takes Beto. Without it the run below would keep the beat by accident
  // and prove nothing about the rule.
  await page.minutes(1);
  await page.push(ANA, { kind: "text", text: "¿ya viene?" });
  await page.minutes(1);

  if (opts.claims) {
    expect(
      "Ana is told she already has a request",
      (await page.slotOf(ANA))?.thread.some((m) => m.includes("Ya tiene una solicitud activa")),
      true,
    );
  }

  // ── 09:09 Carla writes, and there is nowhere to put her ───────────────────
  await page.minutes(1);
  await hail(page, CARLA, PLACES.mirador, ZONES.centro, PLACES.mercado);
  await page.minutes(1);

  const before = await page.slotOf(BETO);

  if (opts.claims) {
    expect("Carla has no slot: both are held", await page.slotOf(CARLA), null);
    expect(
      "the log says where to look for her instead",
      (await page.ticker()).some((l) => l.includes("Carla escribió") && l.includes("mapa")),
      true,
    );
    expect("Beto's slot was not taken from him to make room", stamp(before?.adoptedAt ?? 0), "09:05");
    await shot("04-beto-queued-carla-refused");
  }

  // ── 09:10 ✅ Listo, and the beat ───────────────────────────────────────────
  if (opts.claims) {
    // By hand, on the real phone: the human path and the early-✅ Listo wrinkle in
    // one gesture, since Don José's sprite is still two blocks from the Parque.
    await page.click(`document.querySelector('.slot[data-phone="${JOSE}"] .slot__take')`);
    const pinned = await page.slotOf(JOSE);
    expect("taking control pins the slot", pinned?.pinned, true);
    expect("…and says who is driving", pinned?.word, "Usted al mando");
    expect("the phone's affordances come alive", await live(page, JOSE), "true");
    expect(
      "the log records the hand-over",
      (await page.ticker()).some((l) => l.includes("Usted tomó el control del teléfono de Don José")),
      true,
    );
    await shot("05-control-driver");

    await page.click(
      `[...document.querySelectorAll('.slot[data-phone="${JOSE}"] .action')].reverse()` +
        `.find((b) => b.textContent.includes('Listo'))`,
    );
  } else {
    await page.shot("19-r5off-before-the-tap");
    await page.push(JOSE, { kind: "button", id: "drv:done", title: "✅ Listo" });
  }
  await page.settle();

  const after = await page.slotOf(BETO);
  const ticker = await page.ticker();

  if (!opts.claims) {
    // The negative evidence as a picture: the message the whole demo is built
    // around arrives, and the customer it is addressed to is not on the page.
    await page.shot("20-r5off-beat-lost");
    return { before, after, ticker };
  }

  expect("the trip closed", ticker.some((l) => l.includes("cerró el viaje a Parque Arqueológico")), true);
  expect(
    "…early, and the log says so rather than hiding it",
    ticker.some((l) => l.includes("antes de llegar") && l.includes("termina el trayecto en el mapa")),
    true,
  );
  expect(
    "the pending trip went to the driver who had just freed himself up",
    ticker.some((l) => l.includes("Se desocupó Don José (#3) y va por Beto")),
    true,
  );
  expect("…and Beto, five minutes quiet, hears about it", after?.thread.some((m) => m.includes("viene por usted ahora")), true);
  expect("…in the slot he has had all along", after?.adoptedAt, before?.adoptedAt);
  await shot("06-r5-the-beat");

  // ── The sprite catches up ─────────────────────────────────────────────────
  await page.minutes(1);
  await shot("07-sprite-catching-up");

  // ── Carla is adopted mid-trip, thread and all ─────────────────────────────
  // Ana's ride is over and `closeCustomerSession` has put her back to idle, so
  // hers is the slot with nothing left to show. Carla's conversation is six
  // messages old by the time it lands in it.
  await page.push(CARLA, { kind: "text", text: "¿falta mucho?" });
  await page.minutes(1);

  const carla = await page.slotOf(CARLA);
  const thread = carla?.thread ?? [];
  expect("Carla finally has a slot", carla?.label, "Carla");
  expect("…which is the one Ana had finished with", await page.slotOf(ANA), null);
  expect("…and it shows her conversation from the beginning", thread.length >= 7, true);
  expect("her greeting is first", thread[0]?.includes("buenas"), true);
  expect("…then the bot's answer", thread[1]?.includes("Somos el servicio"), true);
  expect("…then her pin, as a card", thread[2]?.includes("14.84380"), true);
  expect("…then the zone menu", thread[3]?.includes("¿Adónde va?"), true);
  expect("…and the message that won her the slot is last", thread[thread.length - 1]?.includes("Ya tiene una solicitud"), true);
  expect(
    "…which is the one on screen, the thread having been scrolled to its end",
    await page.eval<boolean>(
      `(() => {
         const t = document.querySelector('.slot[data-phone="${CARLA}"] .thread');
         return t.scrollTop + t.clientHeight >= t.scrollHeight - 2;
       })()`,
    ),
    true,
  );
  await shot("08-adopted-mid-trip");

  // ── A person drives a customer's phone ────────────────────────────────────
  const slot = `.slot[data-phone="${CARLA}"]`;
  await page.click(`document.querySelector('${slot} .slot__take')`);

  await page.type(`document.querySelector('${slot} .composer__input')`, "cancelar");
  await page.click(`document.querySelector('${slot} .composer__send')`);
  await page.settle();
  expect(
    "what a person types is an ordinary inbound event: the trip is cancelled",
    (await page.ticker()).some((l) => l.includes("Carla escribió cancelar")),
    true,
  );

  await page.type(`document.querySelector('${slot} .composer__input')`, "buenas, otra vez");
  await page.click(`document.querySelector('${slot} .composer__send')`);
  await page.settle();

  await page.click(`[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('ubicación'))`);
  expect(
    "the location affordance opens the place picker",
    await page.eval<boolean>(`!document.querySelector('${slot} .sheet').hidden`),
    true,
  );
  await shot("09-control-customer-sheet");

  await page.click(`[...document.querySelectorAll('${slot} .sheet__row')].find((r) => r.textContent.includes('${PLACES.marina.name}'))`);
  await page.settle();
  await page.click(`[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Ver zonas'))`);
  await page.click(`[...document.querySelectorAll('${slot} .sheet__row')].find((r) => r.textContent.includes('${ZONES.abajo.name}'))`);
  await page.settle();
  await page.click(`[...document.querySelectorAll('${slot} .action')].reverse().find((b) => b.textContent.includes('Ver lugares'))`);
  await page.click(`[...document.querySelectorAll('${slot} .sheet__row')].find((r) => r.textContent.includes('${PLACES.estadio.name}'))`);
  await page.settle();

  // The pickup reads as the zone and not as the Hotel Marina, because the zone is
  // all the domain keeps: `createHail` stores the pin's coordinates and a
  // `pickup_label` of null, and the landmark a customer happened to be standing
  // next to is never recorded. Naming it here would be the demo inventing detail.
  expect(
    "a hail driven entirely by hand reaches dispatch like any other",
    (await page.ticker()).some((l) => l.includes("Carla pidió un tuktuk desde Centro → Estadio")),
    true,
  );
  expect("…and the slot stays pinned to her while a person holds it", (await page.slotOf(CARLA))?.pinned, true);
  await shot("10-control-customer-hail");

  await page.click(`document.querySelector('${slot} .slot__take')`);
  expect("releasing hands the conversation back", (await page.slotOf(CARLA))?.pinned, false);
  expect("…and the glass goes dead again", await live(page, CARLA), "false");

  // ── Layout ────────────────────────────────────────────────────────────────
  await page.resize(1400, 1000);
  await page.minutes(1);
  expect(
    "under the 1460px breakpoint the map moves above the phones",
    await page.eval<boolean>(
      "document.getElementById('col-map').getBoundingClientRect().bottom <=" +
        " document.getElementById('col-drivers').getBoundingClientRect().top",
    ),
    true,
  );
  expect(
    "…and the phones become a 2×2 grid",
    await page.eval<boolean>(
      `(() => {
         const slots = [...document.querySelectorAll('.slot')].map((s) => s.getBoundingClientRect());
         const rows = new Set(slots.map((r) => Math.round(r.top)));
         const cols = new Set(slots.map((r) => Math.round(r.left)));
         return rows.size === 2 && cols.size === 2;
       })()`,
    ),
    true,
  );
  await shot("11-narrow-map-above");
  await page.resize(1000, 900);
  await shot("12-tablet");
  await page.resize(1920, 1080);

  // ── A tap while the clock is paused ───────────────────────────────────────
  // The page's resting state is paused, so this is very likely the first thing a
  // viewer ever does: take control and touch something before pressing ▶. Paused
  // means sim time is frozen, not that the page has stopped listening — but that
  // is a claim about the drain, and the drain is only reached from the tick loop,
  // so it has to be checked rather than reasoned about.
  await page.click(`document.getElementById('play')`);
  expect("⏸ stops the clock", await page.eval<string>("document.getElementById('play').textContent"), "Seguir");
  const frozen = await page.eval<number>("window.__demo.now()");

  const marvin = `.slot[data-phone="${MARVIN}"]`;
  await page.click(`document.querySelector('${marvin} .slot__take')`);
  await page.type(`document.querySelector('${marvin} .composer__input')`, "ayuda");
  await page.click(`document.querySelector('${marvin} .composer__send')`);
  await page.settle();

  expect(
    "a tap made while paused still reaches the domain",
    (await page.slotOf(MARVIN))?.thread.some((m) => m.includes("terminar el viaje actual")),
    true,
  );
  expect("…and the clock did not move to deliver it", await page.eval<number>("window.__demo.now()"), frozen);
  await page.click(`document.querySelector('${marvin} .slot__take')`);
  await page.click(`document.getElementById('play')`);

  // ── The log runs downwards ────────────────────────────────────────────────
  // Lines are sorted by sim time within a pass and appended between passes, which
  // is only chronological if no pass ever produces a line older than the last one
  // written. Several timestamps come out of the database rather than off the clock
  // — `assigned_at` from the sweep, `done_at` from a completed trip — so this is
  // the assertion that will catch it when Phase 5's busier day breaks the property.
  const stamps = (await page.ticker()).map((line) => line.slice(0, 5));
  expect(
    "every line in the log is stamped no earlier than the one above it",
    stamps.every((face, i) => i === 0 || stamps[i - 1]! <= face),
    true,
  );

  return { before, after, ticker };
}

/** Whether a phone's glass is live, straight off the element the CSS keys on. */
async function live(page: Page, phone: string): Promise<string> {
  return page.eval<string>(`document.querySelector('.slot[data-phone="${phone}"] .phone').dataset.live`);
}

/** The four messages a customer sends to get a tuktuk, spaced like a person. */
async function hail(
  page: Page,
  from: string,
  at: { lat: number; lng: number },
  zone: { id: string; name: string },
  landmark: { id: string; name: string },
): Promise<void> {
  await page.push(from, { kind: "text", text: "buenas" });
  await page.push(from, { kind: "location", lat: at.lat, lng: at.lng }, 3000);
  await page.push(from, { kind: "list", id: `zone:${zone.id}`, title: zone.name }, 6000);
  await page.push(from, { kind: "list", id: `lm:${landmark.id}`, title: landmark.name }, 9000);
}

// ── R5, as a difference ──────────────────────────────────────────────────────

function report(kept: DayResult, lost: DayResult): void {
  console.log(`  with R5      before the tap: ${describe(kept.before)}`);
  console.log(`               after the tap:  ${describe(kept.after)}`);
  console.log(`  without R5   before the tap: ${describe(lost.before)}`);
  console.log(`               after the tap:  ${describe(lost.after)}\n`);

  expect("with R5, Beto is on screen when the driver taps", kept.before !== null, true);
  expect("…in the slot he has had since 09:05", stamp(kept.before?.adoptedAt ?? 0), "09:05");
  expect("…and he is still in it when driverOnWay arrives", kept.after?.adoptedAt, kept.before?.adoptedAt);

  expect("without R5, Carla took his slot while he was quiet", lost.before, null);
  expect(
    "…so the most interesting message in the demo lands on a phone nobody is watching",
    lost.after?.adoptedAt === lost.before?.adoptedAt,
    false,
  );
  expect(
    "…and what the audience sees instead is a slot re-labelled after the fact",
    stamp(lost.after?.adoptedAt ?? 0),
    "09:10",
  );

  const refused = kept.ticker.some((l) => l.includes("Carla escribió") && l.includes("mapa"));
  const evicted = lost.ticker.some((l) => l.includes("Carla escribió") && l.includes("mapa"));
  expect("with R5 the newcomer is turned away and told about", refused, true);
  expect("without it she is simply let in", evicted, false);
}

function describe(view: SlotView | null): string {
  if (!view) return "no slot at all";
  return `${view.label.padEnd(6)} adopted ${stamp(view.adoptedAt)}  ${view.retained ? "held" : "loose"}`;
}

function stamp(at: number): string {
  return at === 0 ? "—" : formatSimTime(at);
}

// ── Building, and breaking, the page ─────────────────────────────────────────

/**
 * Through `demo/bundle.mjs` and not the esbuild CLI, because the demo's database
 * is built from an enumeration of `migrations/` that only a plugin can supply —
 * and the CLI cannot load plugins. A page bundled any other way opens on the
 * schema of whichever migration somebody happened to list.
 */
function build(): void {
  execFileSync(process.execPath, [join(process.cwd(), "demo", "bundle.mjs"), "page"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  say("the page builds");
}

/**
 * A copy of the built page with R5 taken out.
 *
 * A scratch copy rather than a switch on the page, deliberately: a demo carrying a
 * runtime flag that turns off its own best moment is a foot-gun, and the one place
 * that flag would ever be set is here. The regex is asserted to match exactly once,
 * so a rename in `slots.ts` fails this script instead of silently verifying the
 * unmodified page against itself.
 */
function breakR5(): string {
  const dir = join(tmpdir(), "copan-demo-r5off");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "dist"), { recursive: true });

  const source = readFileSync(join(process.cwd(), "demo", "dist", "main.js"), "utf8");
  const pattern = /(R5_SLOT_RETENTION\s*=\s*)true/g;
  const hits = source.match(pattern)?.length ?? 0;
  if (hits !== 1) {
    throw new Error(`FAILED expected one R5_SLOT_RETENTION assignment in the bundle, found ${hits}`);
  }

  writeFileSync(join(dir, "dist", "main.js"), source.replace(pattern, "$1false"));
  writeFileSync(join(dir, "dist", "main.css"), readFileSync(join(process.cwd(), "demo", "dist", "main.css")));
  writeFileSync(join(dir, "index.html"), readFileSync(join(process.cwd(), "demo", "index.html")));
  say("a copy of the page with R5 excised builds too");
  return dir;
}

// ── A static server, because `file://` blocks module imports ─────────────────

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
 * No Puppeteer, because adding it would mean a dependency in `package.json`, and
 * the one thing this phase may not touch is the app's dependencies. What is needed
 * is small: navigate, evaluate, dispatch a mouse event at a point, type, screenshot,
 * and listen for anything the console says.
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
    // Anything this script left in /tmp on an earlier run goes first. Chromium's
    // crash handler outlives the browser by a moment and can write into a profile
    // after it has been deleted, so a run that is killed part-way leaves a
    // directory behind; sweeping at the start keeps that from accumulating.
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
    // Waited for rather than killed and forgotten: chromium writes its profile out
    // as it goes down, and deleting the directory from under it leaves the parts it
    // wrote afterwards behind in /tmp, one directory per run.
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

    // sql.js compiles its WASM and `loadTown` walks the whole gazetteer before the
    // page is usable, and neither is instant.
    await waitFor(
      async () => ((await this.eval<string>("typeof window.__demo")) === "object" ? true : null),
      "the demo never finished booting",
    );
    await this.settle();
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

  /** Focus a field and type into it the way the input pipeline delivers keys. */
  async type(finder: string, text: string): Promise<void> {
    await this.click(finder);
    await this.send("Input.insertText", { text });
  }

  async shot(name: string): Promise<void> {
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

  async push(from: string, payload: Payload, delaySimMs = 0): Promise<void> {
    await this.call("push", from, payload, delaySimMs);
  }

  /** Advance the page by whole sim minutes, in fixed steps rather than by waiting. */
  async minutes(count: number): Promise<void> {
    await this.eval(`window.__demo.step(${STEPS_PER_MINUTE * count}, ${STEP_SIM_MS})`);
  }

  /** Let the queue drain without moving the clock, for a tap just made. */
  async settle(): Promise<void> {
    await this.eval("window.__demo.step(4, 0)");
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

/**
 * The one ticker line containing `needle`, with the whole log in the message when
 * there isn't exactly one. A missing line is the commonest way this script fails
 * and the log is always what explains it.
 */
function only(ticker: string[], needle: string): string {
  const found = ticker.filter((line) => line.includes(needle));
  if (found.length === 1) return found[0]!;
  throw new Error(
    `FAILED expected one ticker line containing "${needle}", found ${found.length}\n` +
      ticker.map((line) => `    ${line}`).join("\n"),
  );
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
