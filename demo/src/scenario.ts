/**
 * "Una hora en Copán" — the scripted hour, as a timeline of beats.
 *
 * ── Why this is a script and not an arrival rate ──────────────────────────────
 *
 * §10 of the plan makes the argument and it is worth restating where the code is.
 * `assignTrip` (`dispatch.ts:144`) only *claims* drivers whose status is
 * `available`, while `quoteWaitMinutes` scores `candidates[0]`, which may be a
 * driver still mid-trip. So the sequence this whole design is built around —
 * quoted from a busy driver, left pending, then handed over the moment somebody
 * taps ✅ Listo — exists only in the window where the fleet is busy and a customer
 * asks anyway. Turn a hail-rate knob up and the screen is nothing but "no hay
 * tuktuks"; turn it down and every hail assigns on the spot and the most
 * interesting path in the app never runs. The window has to be built.
 *
 * So each beat below exists to make one path visible, and the beats are placed
 * around the durations the zone matrix actually produces rather than at round
 * numbers. A beat is a person choosing something — a pin, a tap, a typed word —
 * and it reaches the domain through `queue.push` like everything else (R1). There
 * is no beat that closes a trip, moves a taxi, or writes a row.
 *
 * ── What the hour is, minute by minute ────────────────────────────────────────
 *
 *   09:00  three drivers send a pin            cold-start position fix; Chepe does not
 *   09:02  Ana, Estadio → Parque Central       instant assign, nearest idle driver
 *   09:06  Marvin is flagged down ✋            bandera, the zone menu that follows
 *   09:06  Doña Rosa takes a break ☕           the fleet runs out of free tuktuks
 *   09:07  Beto hails with nobody free         quote from a busy driver, `queued`
 *   09:08  Marvin asks for a break mid-trip    refused: `finishTripFirst`
 *   09:12  Don José taps ✅ Listo               **the chain** — `offerNextTrip` claims
 *                                              Beto's trip and he hears about it
 *   09:13  Carla, Hotel Marina → Hospital      queued too; the Barrio arriba menu works
 *   09:16  Marvin taps ✅ Listo                 the chain again, cross-town this time
 *   09:30  Wilmer types instead of tapping     free text → `noMatch` → `confirmMatch`
 *   09:33  Marvin takes his break ☕            accepted; he leaves the dispatch pool
 *   09:34  Delmy, via "Otro lugar…"            the escape hatch, and queued
 *   09:36  Delmy writes *cancelar*             cancelled while pending, no driver disturbed
 *   09:37  Doña Rosa types *disponible*        back in the pool, by keyword not button
 *   09:38  Marvin comes back 🛺                 a break that ends, as they do
 *   09:47  Elena, Hotel Marina → las ruinas    the trip that teaches the matrix
 *   10:01  the last beat                        and then `main.ts` stops the clock,
 *                                              once the last trip has closed too
 *
 * The minutes are tuned against the seeded jitter, which is why R4 is not a nicety
 * here: a driver who arrives ninety seconds later than this script expects taps
 * ✅ Listo after the beat that assumed he had, and two beats read as bugs. The same
 * seed is the same hour, so the tuning holds. Where a beat depends on a driver
 * having finished — Marvin's break, Delmy finding nobody free — it is placed past
 * the *worst* case the ±25% jitter allows and not past the expected one.
 *
 * ── Every zone's menu is reachable now ───────────────────────────────────────
 *
 * The first draft of this hour could not send anybody to Barrio arriba: the seeded
 * landmark "Hospital / Centro de salud" was 26 characters against a 24-character
 * row-title limit, `renderOutbound` rejected the *whole* menu, and Carla's
 * conversation stopped dead with no reply at all. The hour was written around the
 * hole. Both halves have since been fixed in the app — the name is "Hospital", and
 * `fitRowTitle` trims database text before it can reach the renderer's assertion —
 * so the constraint is gone and Carla goes to the hospital, which is where the hour
 * now demonstrates that a zone with a long name in it answers.
 *
 * Nothing left in the seed is long enough to be trimmed, so the *truncation* is
 * not on screen anywhere and no beat pretends otherwise; `test/gazetteer.test.ts`
 * is what holds the next gazetteer to that.
 *
 * ── What is deliberately not here ─────────────────────────────────────────────
 *
 * Chepe (#15) is seeded `off` and stays parked all day, and the reason is now that
 * he sends nothing rather than that he could not come on if he did: first contact
 * from a registered driver starts their shift (`handleDriver`'s beginShift). A beat
 * that put him on would add a fourth candidate to `rankCandidates` a few minutes
 * before the trip the learning beat depends on, and evict one of the two driver
 * phones that carry the whole morning — for behaviour `test/flow.test.ts` already
 * covers five ways. He is a driver who is not working, which is a thing that
 * happens, and the log says so.
 *
 * No beat names the landmark a customer was picked up at. `createHail` stores the
 * pin and the zone and a `pickup_label` of null, so the system never knew it; the
 * script does, and saying it would be the demo inventing detail the app cannot.
 */

import { rankCandidates } from "../../src/domain/dispatch";
import { MINUTE_MS, SIM_EPOCH } from "./clock";
import type { Fleet, PlanInfo } from "./fleet";
import type { CustomerPlan } from "./npc/customer";
import { CustomerNpc } from "./npc/customer";
import type { DriverAction } from "./npc/driver";
import { DriverNpc } from "./npc/driver";
import type { NpcDeps } from "./npc/npc";
import { Cast } from "./npc/npc";
import type { InboundQueue } from "./queue";
import type { Rng } from "./rng";
import type { HumanControl, SlotBoard } from "./slots";
import type { TickKind } from "./ticker";
import type { DemoTransport } from "./transport";

// ── The cast ─────────────────────────────────────────────────────────────────

/** The three drivers `seeds/dev.sql` puts on shift. Chepe (…0004) is not one. */
const DRIVERS = {
  jose: { phone: "50499990001", name: "Don José" },
  marvin: { phone: "50499990002", name: "Marvin" },
  rosa: { phone: "50499990003", name: "Doña Rosa" },
} as const;

/**
 * Customer numbers, in the 8888 block so a glance at a phone header says which
 * side of the service it belongs to. Nothing in the app cares: a number is a
 * customer precisely because it is not in `drivers`.
 */
const CUSTOMERS = {
  ana: "50488880001",
  beto: "50488880002",
  carla: "50488880003",
  wilmer: "50488880004",
  delmy: "50488880005",
  elena: "50488880006",
} as const;

/**
 * Corners people are standing on, from the seeded gazetteer.
 *
 * Coordinates rather than landmark ids, because a pin is what a customer sends
 * and `zoneForPoint` is what turns it into the zone dispatch reasons in — the
 * same two steps a real phone takes. The gazetteer is still placeholder data
 * (`seeds/dev.sql` says so), and these inherit that.
 */
const PINS = {
  parqueCentral: { lat: 14.8397, lng: -89.1531 },
  hotelMarina: { lat: 14.8399, lng: -89.1528 },
  terminal: { lat: 14.8389, lng: -89.1543 },
  museo: { lat: 14.8402, lng: -89.1421 },
  parqueArq: { lat: 14.84, lng: -89.1417 },
  mirador: { lat: 14.8438, lng: -89.1552 },
  estadio: { lat: 14.8365, lng: -89.1552 },
  gasolinera: { lat: 14.8408, lng: -89.1595 },
} as const;

// ── Beats ────────────────────────────────────────────────────────────────────

/**
 * One scripted moment.
 *
 * `at` is minutes after 09:00 and may be fractional — the point of the fractions
 * is that three drivers sending a pin at the same instant reads as a machine
 * rather than as three people opening WhatsApp.
 */
type Beat = {
  at: number;
  run(at: number): void | Promise<void>;
};

export type ScenarioDeps = {
  db: D1Database;
  queue: InboundQueue;
  transport: DemoTransport;
  control: HumanControl;
  fleet: Fleet;
  board: SlotBoard;
  /** The ticker's `note`. The one seam for a fact the domain cannot know. */
  note: (at: number, kind: TickKind, text: string) => void;
  /** The cast's PRNG stream. Separate from the fleet's, on purpose — see `npc.ts`. */
  rng: Rng;
};

export class Scenario {
  private readonly cast = new Cast();
  private readonly drivers = new Map<string, DriverNpc>();
  private readonly customers = new Map<string, CustomerNpc>();
  private readonly beats: Beat[];
  private fired = 0;
  private readonly detach: (() => void)[] = [];

  constructor(private readonly deps: ScenarioDeps) {
    const npcDeps: NpcDeps = {
      queue: deps.queue,
      transport: deps.transport,
      control: deps.control,
      rng: deps.rng,
    };

    for (const { phone, name } of Object.values(DRIVERS)) {
      this.drivers.set(phone, this.cast.add(new DriverNpc(phone, name, npcDeps)));
    }

    // The map telling the drivers they have arrived. This is the whole of R2 in
    // one line: the sprite reaching the destination is an output of the database,
    // and what it produces is a person deciding to tap something.
    this.detach.push(
      deps.fleet.onLegComplete((done) => {
        for (const driver of this.drivers.values()) driver.onArrival(done);
      }),
      deps.fleet.onPlan((info) => this.explainDrive(info)),
    );

    // Named before anybody speaks: a slot captures its label at adoption, which is
    // the same instant the first message lands, so a customer identified later
    // appears on screen as a phone number and stays that way.
    for (const [key, phone] of Object.entries(CUSTOMERS)) {
      deps.board.identify(phone, NAMES[key as keyof typeof CUSTOMERS]);
    }

    // Sorted, though the script below is already written in order.
    //
    // `tick` walks the list with a cursor and stops at the first beat that is not
    // due, which is what keeps it from re-scanning the whole hour sixty times a
    // second — and it means one beat written out of order would hold up every beat
    // behind it, silently, for the rest of the morning. A stable sort keeps two
    // beats on the same minute in the order they were written, which is how three
    // drivers come on shift one after another.
    this.beats = this.script(npcDeps).sort((a, b) => a.at - b.at);
  }

  /** `HumanControl` needs this to know whose NPC to suspend. */
  get directory(): Cast {
    return this.cast;
  }

  /**
   * One pass, before the queue is drained.
   *
   * Beats first, then the cast: a beat that brings somebody on stage should have
   * their greeting considered for enqueueing in the same pass, or the first
   * message of every conversation would be a frame late for no reason.
   */
  async tick(now: number): Promise<void> {
    while (this.fired < this.beats.length) {
      const beat = this.beats[this.fired]!;
      const at = SIM_EPOCH + Math.round(beat.at * MINUTE_MS);
      if (now < at) break;
      this.fired += 1;
      await beat.run(at);
    }
    this.cast.tick(now);
  }

  /**
   * Whether the script has run out and nobody is still mid-thought.
   *
   * Not "the hour is over": trips already assigned are still being driven, and the
   * drivers who are driving them will tap ✅ Listo when they arrive. The
   * verification harness waits for this *and* for the taxis to settle.
   */
  get scripted(): boolean {
    return this.fired >= this.beats.length && this.cast.quiet && this.deps.queue.waiting === 0;
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
    this.cast.dispose();
  }

  // ── The hour ───────────────────────────────────────────────────────────────

  private script(npcDeps: NpcDeps): Beat[] {
    const beats: Beat[] = [];

    const note = (at: number, kind: TickKind, text: string): Beat => ({
      at,
      run: (when) => this.deps.note(when, kind, text),
    });

    const shift = (at: number, phone: string, pin: { lat: number; lng: number }): Beat => ({
      at,
      run: (when) => this.driver(phone).startShift(when, pin),
    });

    const tap = (
      at: number,
      phone: string,
      action: DriverAction,
      opts: { banderaDest?: string } = {},
    ): Beat => ({
      at,
      run: (when) => this.driver(phone).tap(when, action, opts),
    });

    const keyword = (at: number, phone: string, word: string): Beat => ({
      at,
      run: (when) => this.driver(phone).typeKeyword(when, word),
    });

    const spawn = (at: number, plan: CustomerPlan): Beat => ({
      at,
      run: (when) => {
        const npc = this.cast.add(new CustomerNpc(plan, npcDeps));
        this.customers.set(plan.phone, npc);
        npc.arrive(when);
      },
    });

    const writes = (at: number, phone: string, text: string): Beat => ({
      at,
      run: (when) => this.customers.get(phone)?.say(when, text),
    });

    // ── The morning ─────────────────────────────────────────────────────────
    beats.push(
      note(
        0,
        "beat",
        "Son las nueve de la mañana en Copán Ruinas. Todo lo que sigue pasa por WhatsApp: " +
          "nadie instala nada y nadie llama por teléfono.",
      ),
      // Doña Rosa first, and the order is not cosmetic. There are three drivers on
      // shift and two driver screens, so one of them is going to lose a slot the
      // moment the third pin lands. Opening with hers means the driver who gives it
      // up is the one whose morning happens on the map and in the log — she takes a
      // break at 09:06 and comes back at 09:37, neither of which needs a thread to
      // read — while Don José and Marvin, who between them carry every conversation
      // the hour is built on, keep the same two rectangles from 09:01 to the end.
      // Any other order churns the driver column three times in four minutes.
      shift(0.3, DRIVERS.rosa.phone, PINS.museo),
      shift(0.7, DRIVERS.jose.phone, PINS.parqueCentral),
      shift(1.1, DRIVERS.marvin.phone, PINS.mirador),
      note(
        1.6,
        "beat",
        "Chepe (#15) no entró en turno hoy: su tuktuk aparece apagado en el mapa y el " +
          "despacho no lo toma en cuenta.",
      ),
      // The scoring rule, before it is used, computed with the same function
      // dispatch uses (`rankCandidates`) rather than with a copy of its arithmetic.
      // A viewer who cannot see why a driver was chosen is watching a black box.
      { at: 1.8, run: (when) => this.explainRanking(when, "barrio_abajo") },
      spawn(2, {
        phone: CUSTOMERS.ana,
        name: NAMES.ana,
        pickup: PINS.estadio,
        destZone: "centro",
        destLandmark: "parque_central",
        style: "taps",
      }),
    );

    // ── The fleet fills up ──────────────────────────────────────────────────
    //
    // Two orderings are load-bearing in these four minutes and neither is obvious.
    //
    // The ✋ has to come *before* Doña Rosa's break. Both driver screens are held by
    // Marvin and Don José, and a driver mid-trip is retained while an idle one is
    // not — so if Rosa asks for a break while Marvin is still idle she takes his
    // screen, and the 09:08 refusal then plays on a phone that is not on the page.
    // With the ✋ first he is `on_trip`, Rosa is turned away, and her morning happens on
    // the map and in the log, which is all it needs.
    //
    // And the ✋ has to be as late as the refusal allows, because Marvin's trip is
    // what Carla is queued behind at 09:13. barrio_arriba → Las Ruinas is ten matrix
    // minutes, the longest bandera that does not drive him off the frame; from 09:06
    // that lands him free at about 09:16, which is a three-minute wait for Carla.
    // Fifty-eight seconds — which is what this was before the ✋ stopped being
    // charged a phantom approach — is a queue nobody in the room sees happen.
    beats.push(
      tap(6, DRIVERS.marvin.phone, "bandera", { banderaDest: "ruinas" }),
      tap(6.5, DRIVERS.rosa.phone, "break"),
      note(
        6.8,
        "beat",
        "Ya no queda ningún tuktuk libre. Lo que sigue es lo que el sistema hace " +
          "entonces, que no es decir que no.",
      ),
      spawn(7, {
        phone: CUSTOMERS.beto,
        name: NAMES.beto,
        pickup: PINS.parqueArq,
        destZone: "centro",
        destLandmark: "mercado",
        style: "taps",
      }),
      tap(8, DRIVERS.marvin.phone, "break"),
      // To the hospital, which is in Barrio arriba — the zone whose menu the app
      // could not render until the row-title fix, and the destination the first
      // draft of this hour had to give up on. Same five matrix minutes from the
      // Centro as the Estadio it used to be, so nothing downstream moves.
      spawn(13, {
        phone: CUSTOMERS.carla,
        name: NAMES.carla,
        pickup: PINS.hotelMarina,
        destZone: "barrio_arriba",
        destLandmark: "hospital",
        style: "taps",
      }),
      note(
        21,
        "beat",
        "Los dos viajes que estaban en la lista ya van en camino. El sistema sabe " +
          "dónde va a quedar cada conductor al terminar, y con eso cotiza al siguiente.",
      ),
    );

    // ── Somebody who would rather type ──────────────────────────────────────
    beats.push(
      spawn(30, {
        phone: CUSTOMERS.wilmer,
        name: NAMES.wilmer,
        pickup: PINS.gasolinera,
        // Unused by a typist — he never opens the zone menu — but kept so the plan
        // reads as a whole person and so a change of `style` needs no other edit.
        destZone: "centro",
        destLandmark: "parque_central",
        style: "types",
        // The first name is one nobody put in the gazetteer, which is the common
        // case in a town whose landmark list is still a guess: the bot says it
        // does not know the place and he tries again with something it does.
        typed: ["la pulpería de doña mari", "parque"],
      }),
    );

    // ── A break, a cancellation, and two drivers coming back ────────────────
    beats.push(
      tap(33, DRIVERS.marvin.phone, "break"),
      spawn(34, {
        phone: CUSTOMERS.delmy,
        name: NAMES.delmy,
        pickup: PINS.terminal,
        destZone: "ruinas",
        destLandmark: "parque_arq",
        style: "otherRow",
        typed: ["parque"],
      }),
      writes(36, CUSTOMERS.delmy, "cancelar"),
      // Typed, not tapped. `driverKeywords` exists because buttons fail in the
      // field, and it is the kind of thing no demo thinks to show.
      keyword(37, DRIVERS.rosa.phone, "disponible"),
      tap(38, DRIVERS.marvin.phone, "resume"),
    );

    // ── The trip that teaches the matrix ────────────────────────────────────
    beats.push(
      note(
        46,
        "beat",
        "La matriz dice que del Centro a Las Ruinas son *7 minutos*. Ese número lo " +
          "escribió alguien a mano. Miremos el próximo viaje.",
      ),
      spawn(47, {
        phone: CUSTOMERS.elena,
        name: NAMES.elena,
        pickup: PINS.hotelMarina,
        destZone: "ruinas",
        destLandmark: "parque_arq",
        style: "taps",
      }),
      // The last beat, and therefore half of the stopping rule: `main.ts` halts the
      // clock once the script has run out *and* no trip is still open, so this line
      // is what makes the hour end at the hour rather than whenever the last taxi
      // happens to arrive. It counts nothing — the tally under it is read out of the
      // tables by `Ticker.closing`, because a hand-written "seis clientes" is a
      // number that goes wrong the first time somebody takes a phone.
      note(
        61,
        "beat",
        "Ya es la hora. Nada de lo que vio lo decidió esta página: cada mensaje, cada " +
          "asignación y cada minuto de viaje salió del mismo código que corre en el servidor.",
      ),
    );

    return beats;
  }

  // ── Narration the domain cannot supply ─────────────────────────────────────

  /**
   * The candidate list, as dispatch sees it, a moment before it is used.
   *
   * Read-only and through the domain's own `rankCandidates`, so the numbers cannot
   * disagree with the decision that follows. A second implementation of the
   * scoring rule for narration would be the one thing this demo exists to avoid.
   */
  private async explainRanking(at: number, pickupZone: string): Promise<void> {
    const candidates = await rankCandidates(this.deps.db, pickupZone, at);
    if (candidates.length === 0) return;
    const zone = await this.zoneName(pickupZone);
    const list = candidates
      .map((c) => {
        const who = c.driver.tuktuk_no ? `${c.driver.name} (#${c.driver.tuktuk_no})` : c.driver.name;
        return `${who} a ${Math.round(c.score)} min`;
      })
      .join(", ");
    this.deps.note(
      at,
      "beat",
      `Para alguien en ${zone}, el despacho cuenta espera + camino: ${list}. ` +
        `Se queda con el primero que esté libre.`,
    );
  }

  /**
   * Where the minutes in a drive come from (R3).
   *
   * The map supplies the shape of the route and nothing about its duration: the
   * two numbers below are `travelMinutes` out of the zone matrix, which is the
   * same call `markDriverUnderway` made to decide when this driver frees up. So
   * the drive a viewer watches and the wait the customer was quoted are the same
   * arithmetic, and this line is where anybody can check that.
   */
  private explainDrive(info: PlanInfo): void {
    const { plan } = info;
    if (plan.kind !== "trip") return;
    const who = info.tuktuk ? `${info.name} (#${info.tuktuk})` : info.name;
    const total = (plan.approachMin + plan.legMin).toFixed(0);
    this.deps.note(
      plan.origin,
      "assign",
      plan.approachMin > 0
        ? `${who} tiene ${plan.approachMin} min hasta el cliente y ${plan.legMin} min de ` +
            `viaje: ${total} en total, según la matriz de zonas.`
        : `${who} ya lleva al pasajero: ${plan.legMin} min de viaje según la matriz.`,
    );
  }

  private driver(phone: string): DriverNpc {
    const npc = this.drivers.get(phone);
    // Only reachable by a typo in the script above, and the symptom without this
    // would be a beat that silently does nothing at 09:04.
    if (!npc) throw new Error(`demo scenario: ${phone} is not one of the drivers on shift`);
    return npc;
  }

  private async zoneName(id: string): Promise<string> {
    const row = await this.deps.db
      .prepare("SELECT name FROM zones WHERE id = ?")
      .bind(id)
      .first<{ name: string }>();
    return row?.name ?? id;
  }
}

/**
 * The customers' names.
 *
 * Nowhere in the database, and that is the design: a customer never registers, so
 * nothing but the demo has a name for one. Kept apart from the numbers so the two
 * maps can be read side by side without counting commas.
 */
const NAMES: Record<keyof typeof CUSTOMERS, string> = {
  ana: "Ana",
  beto: "Beto",
  carla: "Carla",
  wilmer: "Wilmer",
  delmy: "Delmy",
  elena: "Elena",
};
