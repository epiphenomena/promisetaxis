/**
 * Four phone slots — two conductores, two clientes — and the rules that decide
 * who is on screen.
 *
 * A slot is a camera onto a conversation, not a person's desk. Nobody is wired to
 * a slot at boot: a phone number earns a slot the first time a message goes in or
 * out of it, and loses it to somebody more interesting later. That is the only way
 * four rectangles can cover a town with more than four phones in it.
 *
 * Which conversations exist is not this file's opinion. It reads the two traffic
 * logs the demo already keeps — `queue.delivered` and `transport.sent` — with a
 * cursor, exactly as `fleet.ts` diffs the database. Nothing here records what the
 * demo *believes* happened (R2); a slot's label, status word and retention all
 * come back out of `drivers`, `trips` and `sessions` on every pass.
 *
 * ── R5, which is the whole point ──────────────────────────────────────────────
 *
 * A customer keeps their slot while they have an open trip, and taking control
 * pins it harder than that. The rule exists for one beat: a customer told
 * `copy.customer.queued` goes quiet, and several sim-minutes later a driver taps
 * ✅ Listo, `offerNextTrip` claims their pending trip (`driver.ts:104-134`) and
 * they finally get `driverOnWay`. That message is the most interesting thing the
 * design does, it arrives long after the conversation looked finished, and a slot
 * that had moved on by then would play it to an empty room.
 *
 * So a new arrival never takes a retained slot. If all four are retained the
 * newcomer stays off screen — they are still on the map as a 👤 once they have a
 * trip, and the ticker says so. Dropping a retained conversation to make room
 * would trade the demo's best moment for a phone nobody has watched yet.
 */

import { formatPhone } from "../../src/domain/roster";
import type { SimClock } from "./clock";
import type { Contact, PhoneRole } from "./phone";
import { Phone } from "./phone";
import type { InboundQueue } from "./queue";
import type { DemoTransport } from "./transport";

export type SlotRole = PhoneRole;

/**
 * R5, as one line, so that a verification run can excise it from a built copy of
 * the page and watch the queued-customer beat break. If this is ever false in
 * something a viewer is looking at, the demo has lost its best minute.
 */
const R5_SLOT_RETENTION = true;

/** How many of each kind. Two and two is what §3's layout has room for. */
const PER_ROLE = 2;

// ── The NPC seam ─────────────────────────────────────────────────────────────

/**
 * What Phase 5's NPCs have to implement so a human can take the wheel.
 *
 * Deliberately only two verbs, and neither of them is a question. The authority
 * on who is driving a phone is `HumanControl.isHuman()` and nothing else — an NPC
 * that kept its own `suspended` flag could disagree with the button on screen,
 * and the way that failure presents is a phone that answers itself while somebody
 * is typing into it. `suspend()` is a courtesy so an NPC can drop intentions it
 * had already formed; it is not where the decision lives.
 */
export type Npc = {
  readonly phone: string;
  /** Stop acting. Anything already scheduled on the queue will still arrive. */
  suspend(at: number): void;
  /** Take over again, reading the last thing the bot said rather than resuming a plan. */
  resume(at: number): void;
};

export type NpcDirectory = {
  npcFor(phone: string): Npc | null;
};

export type ControlChange = { phone: string; human: boolean; at: number };

/**
 * Who is being driven by a person. The authoritative copy of that fact.
 *
 * Phase 5 registers its directory here; until then `take()` simply has nobody to
 * suspend, which is why this can be finished and correct before the NPCs exist.
 */
export class HumanControl {
  private readonly held = new Set<string>();
  private directory: NpcDirectory | null = null;
  private readonly listeners = new Set<(change: ControlChange) => void>();

  register(directory: NpcDirectory): void {
    this.directory = directory;
  }

  /** The one question an NPC may ask before it acts. */
  isHuman(phone: string): boolean {
    return this.held.has(phone);
  }

  onChange(fn: (change: ControlChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  take(phone: string, at: number): void {
    if (this.held.has(phone)) return;
    this.held.add(phone);
    this.directory?.npcFor(phone)?.suspend(at);
    this.announce({ phone, human: true, at });
  }

  release(phone: string, at: number): void {
    if (!this.held.delete(phone)) return;
    this.directory?.npcFor(phone)?.resume(at);
    this.announce({ phone, human: false, at });
  }

  private announce(change: ControlChange): void {
    for (const fn of [...this.listeners]) fn(change);
  }
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * Display names, for the two places that need one: a slot header and the ticker.
 *
 * Customers are in no table — never registering them is the point of the design —
 * so a customer has no name until something outside the domain supplies one.
 * Phase 5's scenario calls `set()` when it spawns an NPC; until then a number
 * formatted the way the app formats it is the honest label, and it is also what a
 * real dispatcher would see.
 */
export class Names {
  private readonly named = new Map<string, string>();

  set(phone: string, name: string): void {
    this.named.set(phone, name);
  }

  of(phone: string): string {
    return this.named.get(phone) ?? formatPhone(phone);
  }
}

// ── Slot state ───────────────────────────────────────────────────────────────

/** Why a slot is being held, in the chrome's own words. */
type StateKind = "waiting" | "riding" | "talking" | "break" | "quiet";

type SlotState = {
  kind: StateKind;
  word: string;
  /** R5: a new arrival may not have this slot. */
  retained: boolean;
  /** The conversation is over — trip closed and the session back to idle. */
  finished: boolean;
};

const HELD_TITLE =
  "Este espacio no se le quita mientras su viaje siga abierto: " +
  "el aviso de que un tuktuk va en camino puede llegar varios minutos después.";

type Occupant = {
  contact: Contact;
  phone: Phone;
  /** Sim time of the last message either way, which is what "quiet" is measured in. */
  lastTrafficAt: number;
  /** Sim time this slot took the conversation on. */
  adoptedAt: number;
};

export type SlotView = {
  role: SlotRole;
  phone: string | null;
  label: string;
  pinned: boolean;
  retained: boolean;
  word: string;
  /**
   * When this slot adopted this conversation.
   *
   * The one number that tells a held slot from a slot that let the conversation go
   * and picked it up again later: both end with the same phone on screen and the
   * same thread, and only this says whether anybody could have watched it arrive.
   */
  adoptedAt: number;
  /** The thread as text, oldest first. The adoption proof reads this. */
  thread: string[];
};

export type BoardDeps = {
  db: D1Database;
  clock: SimClock;
  queue: InboundQueue;
  transport: DemoTransport;
  names: Names;
  control: HumanControl;
  /** Where a slot-level event goes. The ticker's `note`, in practice. */
  note: (at: number, kind: "control" | "refuse", text: string) => void;
};

// ── One slot ─────────────────────────────────────────────────────────────────

class Slot {
  readonly el: HTMLElement;

  occupant: Occupant | null = null;
  /** Taking control pins the slot against R5's own preferences. */
  pinned = false;
  state: SlotState | null = null;

  private readonly stage: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly word: HTMLElement;
  private readonly take: HTMLButtonElement;

  constructor(
    readonly role: SlotRole,
    private readonly deps: BoardDeps,
  ) {
    this.el = element("section", "slot");
    this.el.dataset.role = role;

    this.stage = element("div", "slot__stage");
    this.stage.append(emptyCard(role));

    this.bar = element("div", "slot__bar");
    this.bar.hidden = true;
    const state = element("span", "slot__state");
    this.dot = element("span", "slot__dot");
    this.word = element("span", "slot__word");
    state.append(this.dot, this.word);
    this.take = document.createElement("button");
    this.take.type = "button";
    this.take.className = "slot__take";
    this.take.addEventListener("click", () => this.toggleControl());
    this.bar.append(state, this.take);

    this.el.append(this.stage, this.bar);
    this.paint();
  }

  // ── Adoption ──────────────────────────────────────────────────────────────

  /**
   * Show a conversation, rebuilding whatever of it already happened.
   *
   * The phone is built fresh rather than re-pointed: `Phone` subscribes in its
   * constructor and `destroy()` exists precisely for this rotation, so swapping
   * the object is the one way to be sure the number that just left the slot has
   * stopped being listened to. The thread then comes back out of the two traffic
   * logs — a slot that adopts a trip in progress and shows an empty thread is
   * indistinguishable, on screen, from a customer who never said anything.
   */
  adopt(contact: Contact, at: number): void {
    this.release();
    const phone = new Phone(contact, this.deps);
    // On the page *before* the thread is rebuilt. `scrollTop = scrollHeight` does
    // nothing to an element that has never been laid out, so rebuilding first
    // leaves the thread parked at its oldest message — and the message that won
    // this slot, the one somebody needs to read, is the newest.
    this.stage.replaceChildren(phone.el);
    phone.rebuild();
    phone.setLive(this.deps.control.isHuman(contact.phone));
    this.occupant = { contact, phone, lastTrafficAt: at, adoptedAt: at };
    this.bar.hidden = false;
    // On the element as well as in the view, so that a screenshot's DOM says which
    // conversation each rectangle was showing.
    this.el.dataset.phone = contact.phone;
    this.paint();
  }

  /**
   * Stop showing this conversation, and detach both of its listeners.
   *
   * Control is handed back first. A pinned slot is never a victim, so in practice
   * this cannot run on a phone somebody is driving — but if it ever did, leaving
   * the number marked as human-driven would suspend an NPC forever with nothing on
   * screen to explain why it had gone quiet.
   */
  release(): void {
    if (!this.occupant) return;
    this.deps.control.release(this.occupant.contact.phone, this.deps.clock.now());
    this.occupant.phone.destroy();
    this.occupant = null;
    this.state = null;
    this.pinned = false;
    this.stage.replaceChildren(emptyCard(this.role));
    this.bar.hidden = true;
    delete this.el.dataset.phone;
    this.paint();
  }

  holds(phone: string): boolean {
    return this.occupant?.contact.phone === phone;
  }

  touch(at: number): void {
    if (this.occupant) this.occupant.lastTrafficAt = Math.max(this.occupant.lastTrafficAt, at);
  }

  get quietSince(): number {
    return this.occupant?.lastTrafficAt ?? 0;
  }

  /** R5 and the pin, in the order that matters. */
  get retained(): boolean {
    if (this.pinned) return true;
    return R5_SLOT_RETENTION && (this.state?.retained ?? false);
  }

  get finished(): boolean {
    return !this.pinned && (this.state?.finished ?? true);
  }

  async refresh(state: SlotState): Promise<void> {
    this.state = state;
    await this.occupant?.phone.refresh();
    this.paint();
  }

  // ── Take control ──────────────────────────────────────────────────────────

  private toggleControl(): void {
    const occupant = this.occupant;
    if (!occupant) return;
    const at = this.deps.clock.now();
    const phone = occupant.contact.phone;

    if (this.deps.control.isHuman(phone)) {
      this.deps.control.release(phone, at);
      this.pinned = false;
    } else {
      this.deps.control.take(phone, at);
      // Pinned before anything else can run: an eviction between the two would
      // hand the human's phone to somebody else mid-sentence.
      this.pinned = true;
    }

    occupant.phone.setLive(this.deps.control.isHuman(phone));
    this.paint();
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private paint(): void {
    const occupant = this.occupant;
    const human = occupant ? this.deps.control.isHuman(occupant.contact.phone) : false;

    this.el.dataset.pinned = String(this.pinned);
    this.el.dataset.retained = String(this.retained);
    this.el.dataset.occupied = String(occupant !== null);

    this.take.textContent = human ? "↩ Devolver el control" : "🎮 Tomar el control";
    this.take.setAttribute("aria-pressed", String(human));
    this.take.title = human
      ? "Devuelve la conversación a quien la llevaba."
      : "Usted escribe y toca por esta persona. Todo entra por el mismo camino que el resto.";

    const state = this.state;
    this.dot.dataset.kind = human ? "human" : (state?.kind ?? "quiet");
    this.word.textContent = human ? "Usted al mando" : (state?.word ?? "…");
    this.word.title = this.retained && !human ? HELD_TITLE : "";
  }

  view(): SlotView {
    const occupant = this.occupant;
    return {
      role: this.role,
      phone: occupant?.contact.phone ?? null,
      label: occupant?.contact.name ?? "",
      pinned: this.pinned,
      retained: this.retained,
      word: this.word.textContent ?? "",
      adoptedAt: occupant?.adoptedAt ?? 0,
      thread: occupant?.phone.threadText() ?? [],
    };
  }
}

// ── The board ────────────────────────────────────────────────────────────────

export class SlotBoard {
  private readonly slots: Slot[] = [];

  /** Cursors into the two traffic logs. A conversation is born at its first message. */
  private inbound = 0;
  private outbound = 0;

  /** Phone → is this number in `drivers`. Asked once per number, not per drain. */
  private readonly roles = new Map<string, SlotRole>();

  /** Numbers already reported as having no slot, so the ticker says it once. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly deps: BoardDeps,
    columns: { drivers: HTMLElement; customers: HTMLElement },
  ) {
    for (let i = 0; i < PER_ROLE; i += 1) {
      const driver = new Slot("driver", deps);
      const customer = new Slot("customer", deps);
      this.slots.push(driver, customer);
      columns.drivers.append(driver.el);
      columns.customers.append(customer.el);
    }
  }

  /**
   * One pass, after a drain.
   *
   * Retention is recomputed before anything is placed, because eviction decides
   * against it — a stale answer here is the one bug that can lose the beat R5
   * exists for.
   */
  async observe(now: number): Promise<void> {
    const touched = this.scanTraffic();
    for (const [phone, at] of touched) {
      for (const slot of this.slots) if (slot.holds(phone)) slot.touch(at);
    }

    await this.refreshStates();

    for (const [phone, at] of touched) {
      if (this.slots.some((slot) => slot.holds(phone))) continue;
      await this.place(phone, at);
    }
  }

  /** Phase 5 and the demo's own scripts name the customers they invent. */
  identify(phone: string, name: string): void {
    this.deps.names.set(phone, name);
  }

  /**
   * Take the board off the page.
   *
   * Phase 5's "run the hour again" control rebuilds the whole world against a
   * fresh database, and a board left behind would keep four phones listening to a
   * queue and a transport that no longer exist — which on screen is four
   * conversations frozen at yesterday's last message.
   */
  dispose(): void {
    for (const slot of this.slots) {
      slot.release();
      slot.el.remove();
    }
    this.slots.length = 0;
  }

  snapshot(): SlotView[] {
    return this.slots.map((slot) => slot.view());
  }

  /** For the verification harness: the slot showing this number, if any. */
  viewOf(phone: string): SlotView | null {
    return this.slots.find((slot) => slot.holds(phone))?.view() ?? null;
  }

  // ── Traffic ───────────────────────────────────────────────────────────────

  /**
   * Which numbers have said or heard anything since the last pass.
   *
   * A cursor over the logs rather than a subscription, so a conversation that
   * began and ended inside one drain — which is what a 12× frame looks like —
   * still registers, and the slot that picks it up rebuilds it from the same logs.
   */
  private scanTraffic(): Map<string, number> {
    const touched = new Map<string, number>();
    const bump = (phone: string, at: number): void => {
      touched.set(phone, Math.max(touched.get(phone) ?? 0, at));
    };

    const { delivered } = this.deps.queue;
    for (; this.inbound < delivered.length; this.inbound += 1) {
      const record = delivered[this.inbound]!;
      bump(record.event.from, record.event.at);
    }

    const { sent } = this.deps.transport;
    for (; this.outbound < sent.length; this.outbound += 1) {
      const record = sent[this.outbound]!;
      bump(record.to, record.at);
    }

    return touched;
  }

  // ── Placement ─────────────────────────────────────────────────────────────

  private async place(phone: string, at: number): Promise<void> {
    const role = await this.roleOf(phone);
    const contact: Contact = { phone, name: this.deps.names.of(phone), role };

    const free = this.slots.find((slot) => slot.role === role && slot.occupant === null);
    if (free) {
      await this.fill(free, contact, at);
      return;
    }

    const victim = this.pickVictim(role);
    if (!victim) {
      // The rule doing its work, out loud. Every slot of this kind is holding a
      // conversation that is not over, so this one waits — on the map, where a
      // pending trip is already drawn as a 👤.
      if (!this.refused.has(phone)) {
        this.refused.add(phone);
        this.deps.note(
          at,
          "refuse",
          role === "customer"
            ? `${contact.name} escribió, pero las dos pantallas de clientes siguen ocupadas. ` +
                `Mire el mapa 👤.`
            : `No queda pantalla para ${contact.name}: las dos de conductores siguen ocupadas.`,
        );
      }
      return;
    }

    await this.fill(victim, contact, at);
  }

  private async fill(slot: Slot, contact: Contact, at: number): Promise<void> {
    slot.adopt(contact, at);
    this.refused.delete(contact.phone);
    // Straight away rather than on the next pass: a slot whose state word says
    // nothing is a slot that looks broken for one frame, and at 1× one frame of
    // the wrong answer is 16 ms of a viewer wondering what they missed.
    await slot.refresh(await this.stateOf(contact.phone, contact.role));
  }

  /**
   * Who gives up their slot.
   *
   * Finished conversations first — a closed trip with the session back to idle has
   * nothing left to show — and within that, whoever has been quiet longest. A
   * retained or pinned slot is not a candidate at any price, which is the whole
   * of R5: the alternative, "evict the quietest whatever it is doing", is exactly
   * the policy that loses the queued customer, because going quiet is what a
   * queued customer does.
   */
  private pickVictim(role: SlotRole): Slot | null {
    return (
      this.slots
        .filter((slot) => slot.role === role && !slot.retained)
        .sort(
          (a, b) =>
            Number(b.finished) - Number(a.finished) || a.quietSince - b.quietSince,
        )[0] ?? null
    );
  }

  private async refreshStates(): Promise<void> {
    for (const slot of this.slots) {
      const occupant = slot.occupant;
      if (!occupant) continue;
      await slot.refresh(await this.stateOf(occupant.contact.phone, slot.role));
    }
  }

  // ── What the database says about a conversation ────────────────────────────

  private async stateOf(phone: string, role: SlotRole): Promise<SlotState> {
    return role === "driver" ? this.driverState(phone) : this.customerState(phone);
  }

  private async customerState(phone: string): Promise<SlotState> {
    // `on_trip` is included for completeness rather than because a hail reaches
    // it: `markDriverUnderway` deliberately leaves a hail `assigned` so the
    // customer can still cancel, and only a bandera is ever `on_trip` — and a
    // bandera has no customer phone at all.
    const trip = await this.deps.db
      .prepare(
        `SELECT state FROM trips
          WHERE customer_phone = ? AND state IN ('pending','assigned','on_trip')
          ORDER BY requested_at DESC LIMIT 1`,
      )
      .bind(phone)
      .first<{ state: string }>();

    if (trip?.state === "pending") {
      return { kind: "waiting", word: "Espera tuktuk", retained: true, finished: false };
    }
    if (trip) {
      return { kind: "riding", word: "Tuktuk en camino", retained: true, finished: false };
    }

    // No open trip, so the only thing that can still be owed to this number is a
    // reply to a half-finished conversation. `closeCustomerSession` is what puts
    // it back to idle when the ride ends (`driver.ts:94`).
    const session = await this.deps.db
      .prepare("SELECT state FROM sessions WHERE phone = ?")
      .bind(phone)
      .first<{ state: string }>();
    const talking = session !== null && session.state !== "idle";

    return talking
      ? { kind: "talking", word: "En conversación", retained: true, finished: false }
      : { kind: "quiet", word: "Conversación cerrada", retained: false, finished: true };
  }

  private async driverState(phone: string): Promise<SlotState> {
    const row = await this.deps.db
      .prepare(
        `SELECT d.status AS status,
                (SELECT COUNT(*) FROM trips t
                  WHERE t.driver_id = d.id AND t.state IN ('assigned','on_trip')) AS open
           FROM drivers d WHERE d.phone = ?`,
      )
      .bind(phone)
      .first<{ status: string; open: number }>();

    if (!row) {
      return { kind: "quiet", word: "Sin turno", retained: false, finished: true };
    }
    if (row.open > 0) {
      return { kind: "riding", word: "Con viaje abierto", retained: true, finished: false };
    }
    if (row.status === "break") {
      // Held: a driver on break is one tap from coming back, and that tap is what
      // pulls a queued trip out of the list.
      return { kind: "break", word: "En descanso", retained: true, finished: false };
    }
    return { kind: "quiet", word: "Sin viaje", retained: false, finished: true };
  }

  private async roleOf(phone: string): Promise<SlotRole> {
    const known = this.roles.get(phone);
    if (known) return known;

    // The same test `handleInbound` makes, for the same reason: a number in
    // `drivers` is a driver and everyone else is a customer, so nobody has to say
    // which they are. Asked of the database rather than of a list in this file, or
    // a driver added by the office mid-demo would land in a customer slot.
    const row = await this.deps.db
      .prepare("SELECT name FROM drivers WHERE phone = ? AND active = 1")
      .bind(phone)
      .first<{ name: string }>();

    const role: SlotRole = row ? "driver" : "customer";
    if (row) this.deps.names.set(phone, row.name);
    this.roles.set(phone, role);
    return role;
  }
}

// ── Chrome ───────────────────────────────────────────────────────────────────

/**
 * What a slot shows before anyone has written anything.
 *
 * This is the page's resting appearance — four of these are what a viewer sees
 * before pressing 🎬 — so it has to read as "waiting for the hour to start" and not
 * as a component that failed to load. Phone-shaped and phone-sized for the same
 * reason: nothing moves when somebody arrives.
 */
function emptyCard(role: SlotRole): HTMLElement {
  const card = element("div", "slot__empty");
  const mark = element("span", "slot__empty-mark");
  mark.textContent = role === "driver" ? "🛺" : "💬";
  const head = element("span", "slot__empty-head");
  head.textContent = role === "driver" ? "Ningún conductor en pantalla" : "Ningún cliente en pantalla";
  const note = element("p", "slot__empty-note");
  note.textContent =
    role === "driver"
      ? "Aquí aparece la conversación de un conductor en cuanto empiece su turno."
      : "Aquí aparece la conversación de quien pida un tuktuk.";
  // The way in, said once per empty slot. Four rectangles that explain themselves
  // and then leave the viewer with nothing to press is the resting state Phase 4
  // shipped; the hour control is what it was waiting for.
  const hint = element("p", "slot__empty-hint");
  hint.textContent = "Pulse 🎬 Empezar la hora.";
  card.append(mark, head, note, hint);
  return card;
}

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}
