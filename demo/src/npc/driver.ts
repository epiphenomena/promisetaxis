/**
 * A tuktuk driver with three buttons and a day's work.
 *
 * The driver's side of the conversation is almost entirely one decision — "have I
 * arrived?" — and the honest answer to it does not come from the database. The
 * domain has no position tracking beyond the trip it last closed; the *map* is
 * what knows where the sprite is. So this NPC waits for `fleet.onLegComplete` with
 * `leg === 'carry'` and taps ✅ Listo then, which is R2 running the only direction
 * it runs: the drawing prompts the person, the person's tap changes the database,
 * and the database is what moves the drawing next time.
 *
 * Nothing here closes a trip by writing to a row, and nothing taps ✅ Listo because
 * a beat said so at 09:11. A beat can hand this NPC a ✋ Bandera or a ☕ Descanso —
 * those are choices a driver makes, not consequences of arriving — but a trip ends
 * when the taxi gets there.
 *
 * The one piece of memory worth explaining is `owed`. A tap dropped because
 * somebody had taken the wheel must not be forgotten: a `drv:done` lost that way
 * is a trip that stays open for the rest of the day, its driver never returns to
 * the pool, and dispatch quietly degrades with nothing on screen to say why. So
 * the obligation outlives the intention, and `resume()` re-forms it.
 */

import { copy, driverKeywords } from "../../../src/domain/copy";
import type { OutboundSpec } from "../../../src/domain/types";
import type { LegDone } from "../fleet";
import type { NpcDeps } from "./npc";
import { ReactiveNpc, rowWithId, rowsOf } from "./npc";

/** The four taps a driver has, by the id the domain reads them as. */
const TAP = {
  done: { id: "drv:done", title: copy.driver.buttons.done },
  bandera: { id: "drv:bandera", title: copy.driver.buttons.bandera },
  break: { id: "drv:break", title: copy.driver.buttons.break },
  resume: { id: "drv:resume", title: copy.driver.buttons.resume },
} as const;

export type DriverAction = keyof typeof TAP;

export class DriverNpc extends ReactiveNpc {
  /** A trip whose ✅ Listo this driver owes, until the domain confirms it landed. */
  private owed: number | null = null;

  /** Trips already closed, so an arrival announced twice is tapped once. */
  private readonly closed = new Set<number>();

  /** Where the scenario said this driver is taking the flagged-down passenger. */
  private banderaDest: string | null = null;

  constructor(
    phone: string,
    readonly name: string,
    deps: NpcDeps,
  ) {
    super(phone, deps);
  }

  /**
   * Start the shift by sending a pin.
   *
   * Unprompted, exactly as it is in the field: nothing the bot sends asks a driver
   * for a shift-start pin unless their `zone_id` is null, and the three drivers on
   * shift all carry a home zone from the roster.
   *
   * It does two things at once, which is worth knowing when reading the log. The
   * pin fixes the position, and — for a driver whose status is `off` — *first
   * contact of any kind* is what joins them to dispatch, so the same message also
   * starts the shift and writes a `status_events` row. The seeded three are already
   * `available`, so for them only the position moves; Chepe would come on if he
   * ever sent anything, and sends nothing.
   */
  startShift(at: number, pin: { lat: number; lng: number }): void {
    this.intend({ kind: "location", lat: pin.lat, lng: pin.lng }, at);
  }

  /** A scripted choice: ✋ Bandera, ☕ Descanso, 🛺 Disponible. */
  tap(at: number, action: DriverAction, opts: { banderaDest?: string } = {}): void {
    if (opts.banderaDest) this.banderaDest = opts.banderaDest;
    const tap = TAP[action];
    this.intend({ kind: "button", id: tap.id, title: tap.title }, at);
  }

  /**
   * Type the same thing instead of tapping it.
   *
   * `driverKeywords` exists because buttons fail in the field — a cracked screen,
   * an old client, a message forwarded as text — and it is the kind of detail a
   * demo would never think to show. The word is looked up in the domain's own
   * table so this cannot drift into a keyword the app does not accept.
   */
  typeKeyword(at: number, word: string): void {
    if (!(word in driverKeywords)) {
      throw new Error(`demo scenario: "${word}" is not a keyword src/domain/copy.ts accepts`);
    }
    this.intend({ kind: "text", text: word }, at);
  }

  /**
   * The sprite got where the board said it was going.
   *
   * Only the carrying leg counts. Reaching the *pickup* is not an event the domain
   * has a message for — there is no "passenger aboard" button, deliberately, so
   * that a customer can still cancel — and a reposition is the taxi drifting back
   * to a rank with nobody in it.
   */
  onArrival(done: LegDone): void {
    if (done.phone !== this.phone) return;
    if (done.leg !== "carry" || done.tripId === null) return;
    if (this.closed.has(done.tripId)) return;
    this.owed = done.tripId;
    // Anchored on the leg's *scheduled* end rather than on the frame that noticed
    // it, which is what keeps a leg crossed inside one 12× frame from stamping the
    // tap with a time that depends on the frame rate.
    this.intend({ kind: "button", id: TAP.done.id, title: TAP.done.title }, done.at);
  }

  protected consider(spec: OutboundSpec, at: number): void {
    if (spec.kind === "list") {
      this.pickBanderaZone(spec, at);
      return;
    }

    if (spec.kind === "text" && spec.body === copy.driver.tripDone) {
      // Confirmation that the tap landed. Clearing the obligation here rather
      // than when it was enqueued is what makes it survive a hand-over: between
      // the two, a person may have taken the phone and the tap may never have
      // gone in.
      if (this.owed !== null) this.closed.add(this.owed);
      this.owed = null;
      return;
    }

    if (spec.kind === "text" && spec.body === copy.driver.noActiveTrip) {
      // Somebody already closed it — a person driving this phone, most likely.
      // Standing down is the only sensible answer; tapping again would loop.
      if (this.owed !== null) this.closed.add(this.owed);
      this.owed = null;
    }
  }

  /**
   * Re-form the obligation after a hand-over, on top of re-reading the last
   * message the way every NPC does.
   */
  override resume(at: number): void {
    super.resume(at);
    if (this.owed !== null && !this.finished) {
      this.intend({ kind: "button", id: TAP.done.id, title: TAP.done.title }, at);
    }
  }

  private pickBanderaZone(spec: OutboundSpec, at: number): void {
    const rows = rowsOf(spec);
    if (rows.length === 0 || !rows[0]!.id.startsWith("bzone:")) return;

    // Whatever the scenario said, or the first zone on the menu. A driver with a
    // passenger in the back does not leave the question open, and leaving the trip
    // without a destination would strand it `on_trip` with nowhere to drive to.
    const wanted = this.banderaDest ? rowWithId(spec, `bzone:${this.banderaDest}`) : null;
    const row = wanted ?? rows[0]!;
    this.banderaDest = null;
    this.intend({ kind: "list", id: row.id, title: row.title }, at);
  }
}
