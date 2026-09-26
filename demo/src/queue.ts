/**
 * The single inbound queue — the only way into the system (R1).
 *
 * An NPC deciding to tap ✅ Listo and a person actually tapping it do the same
 * one thing: `push()` an `InboundEvent` at a sim time. There is no privileged
 * NPC path and no "simulate an assignment" shortcut, which is what guarantees
 * the demo cannot show behaviour the Worker does not have. If a beat cannot be
 * expressed as an inbound event, it is not in the demo.
 *
 * Every event is delivered through `handleInbound` with a FlowContext built at
 * the event's own sim time, exactly as the Worker's webhook handler does it
 * (`src/index.ts`). One context per event, never one per conversation — sharing
 * would freeze `now` and every wait quote after the first would be wrong.
 */

import { createFlowContext, handleInbound } from "../../src/domain/flow";
import { sweepStuckState } from "../../src/domain/sweep";
import type { InboundEvent, InboundPayload, Transport } from "../../src/domain/types";
import { MINUTE_MS, SIM_EPOCH } from "./clock";
import { threadOrdinal } from "./transport";

/**
 * How many events one drain will deliver before giving the frame back.
 *
 * The loop re-checks the queue after every delivery, because a handler can
 * schedule more work — that is how an NPC answers a question. A reactive NPC
 * that ever schedules at `now` with no think-time would therefore spin forever
 * and the page would freeze solid with no error. This bound turns that bug into
 * a visibly stuttering demo instead of a dead one.
 */
const MAX_PER_DRAIN = 200;

/** One event that actually reached the domain. */
export type Delivered = {
  ordinal: number;
  event: InboundEvent;
};

export type InboundListener = (delivered: Delivered) => void;

type Scheduled = {
  at: number;
  /** Insertion order, so events sharing a sim minute keep the order they were pushed. */
  seq: number;
  event: InboundEvent;
};

export type DrainResult = {
  delivered: number;
  swept: boolean;
};

export class InboundQueue {
  readonly delivered: Delivered[] = [];

  /**
   * The sim instant the domain is running at, or null between deliveries.
   *
   * Added for the NPCs, and load-bearing for R4. An NPC answers `now + think`,
   * and the only `now` that is the same in every run is the one the domain itself
   * is using: `ctx.now`, which is the causing event's `at` during a delivery and
   * the sweep's instant during a sweep. The sim clock's own reading is whichever
   * frame happened to run the drain, so measuring think-time from it would make
   * every trip, quote and learned travel time depend on the frame rate.
   */
  private running: number | null = null;

  private pending: Scheduled[] = [];
  private readonly listeners = new Map<string, Set<InboundListener>>();
  private seq = 0;
  private messages = 0;
  private draining = false;
  private lastSweptMinute: number | null = null;

  /**
   * `onTrouble` exists because a throw in here is invisible otherwise: the tick
   * loop would keep running, the clock would keep advancing, and the page would
   * ignore every tap while looking perfectly alive.
   */
  constructor(
    private readonly db: D1Database,
    private readonly transport: Transport,
    private readonly onTrouble: (err: unknown) => void,
  ) {}

  /**
   * Schedule one inbound event, and mint its message id.
   *
   * The id is minted here and nowhere else, which is the whole reason this is a
   * single queue. `events.message_id` carries a unique index that `handleInbound`
   * uses as its dedup gate, so a repeated id is swallowed in silence — and on
   * screen a silently swallowed tap reads as "the button is broken". A counter
   * that only ever increments cannot collide with itself, so the counter *is*
   * the guarantee.
   */
  push(at: number, from: string, payload: InboundPayload): InboundEvent {
    const event: InboundEvent = {
      from,
      messageId: `demo.${++this.messages}`,
      at,
      payload,
    };
    this.pending.push({ at, seq: ++this.seq, event });
    return event;
  }

  /** Watch one number's inbound traffic. Returns the detach. */
  listen(phone: string, fn: InboundListener): () => void {
    const set = this.listeners.get(phone) ?? new Set<InboundListener>();
    this.listeners.set(phone, set);
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Everything ever delivered from one number, for rebuilding a thread. */
  to(phone: string): Delivered[] {
    return this.delivered.filter((d) => d.event.from === phone);
  }

  /** Events scheduled but not yet due — what the ticker would call "coming up". */
  get waiting(): number {
    return this.pending.length;
  }

  /** See `running`. Read by the NPCs, written nowhere but here. */
  get runningAt(): number | null {
    return this.running;
  }

  /**
   * Deliver everything due at `now`, oldest sim time first, then run the cron.
   *
   * Reentrant calls return immediately rather than queueing: the tick loop fires
   * every frame and a single delivery is many awaited D1 round-trips, so at 12×
   * the next frame reliably arrives mid-drain. Two drains interleaved would
   * deliver events out of sim order.
   */
  async drain(now: number): Promise<DrainResult> {
    if (this.draining) return { delivered: 0, swept: false };
    this.draining = true;
    try {
      let count = 0;
      while (count < MAX_PER_DRAIN) {
        const next = this.takeDue(now);
        if (!next) break;
        await this.deliver(next);
        count += 1;
      }
      const swept = await this.sweep(now);
      return { delivered: count, swept };
    } finally {
      // In a `finally` deliberately: a single throw escaping without this leaves
      // the queue permanently closed, and the page keeps animating over it.
      this.draining = false;
    }
  }

  /** The due event with the earliest sim time, insertion order breaking ties. */
  private takeDue(now: number): InboundEvent | null {
    let bestIndex = -1;
    let best: Scheduled | null = null;

    for (let i = 0; i < this.pending.length; i += 1) {
      const candidate = this.pending[i]!;
      if (candidate.at > now) continue;
      if (
        best === null ||
        candidate.at < best.at ||
        (candidate.at === best.at && candidate.seq < best.seq)
      ) {
        best = candidate;
        bestIndex = i;
      }
    }

    if (!best) return null;
    this.pending.splice(bestIndex, 1);
    return best.event;
  }

  private async deliver(event: InboundEvent): Promise<void> {
    // Announced before the domain runs, not after: everything the bot replies
    // reaches the phone from inside `handleInbound`, so echoing afterwards would
    // show the answer above the question.
    const record: Delivered = { ordinal: threadOrdinal(), event };
    this.delivered.push(record);
    for (const fn of [...(this.listeners.get(event.from) ?? [])]) fn(record);

    try {
      this.running = event.at;
      await handleInbound(createFlowContext(this.db, this.transport, event.at), event);
    } catch (err) {
      // One bad event must not take the rest of the day down with it. The most
      // likely cause is `renderOutbound` rejecting a menu that outgrew
      // WhatsApp's limits, which is a real bug worth seeing rather than hiding.
      this.onTrouble(err);
    } finally {
      this.running = null;
    }
  }

  /**
   * The cron trigger, on the Worker's own one-minute cadence.
   *
   * Only the newest sim minute is swept rather than every minute skipped over: it
   * is an idempotent catch-up pass, so running it once after a jump finds exactly
   * what running it four times would.
   */
  private async sweep(now: number): Promise<boolean> {
    const minute = Math.floor((now - SIM_EPOCH) / MINUTE_MS);
    if (this.lastSweptMinute === minute) return false;
    this.lastSweptMinute = minute;

    try {
      this.running = now;
      await sweepStuckState(createFlowContext(this.db, this.transport, now));
      return true;
    } catch (err) {
      this.onTrouble(err);
      return false;
    } finally {
      this.running = null;
    }
  }
}
