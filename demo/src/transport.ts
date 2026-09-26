/**
 * The demo's channel: outbound messages routed to whoever is showing that phone.
 *
 * Deliberately a subscription keyed by phone number rather than two fields
 * holding a customer and a driver phone. Phase 4 puts four slots in front of
 * this, each rotating through whichever numbers are interesting at the moment,
 * and a slot taking over a number is then one `listen()` call — not a change here.
 *
 * `send()` renders each message and throws the result away, exactly as
 * `MemoryTransport` does in the tests. That is not waste: `renderOutbound` is
 * where WhatsApp's 3-button and 10-row limits are asserted, so a menu that grew
 * too long fails in the demo for the same reason it would fail in production,
 * instead of quietly rendering an eleventh row nobody would ever see on a phone.
 */

import { renderOutbound } from "../../src/adapters/whatsapp/outbound";
import type { OutboundMessage, Transport } from "../../src/domain/types";

/**
 * One counter for messages in both directions.
 *
 * A phone's thread is the merge of the inbound log and the outbound log, and
 * `at` cannot order that merge: with the clock paused an entire conversation
 * carries one sim minute, and even running, a reply is stamped with the sim time
 * of the event that caused it. Phase 4 has to rebuild a thread when a slot picks
 * up a number mid-trip, and this is the only thing that will tell it what came
 * after what.
 */
let ordinals = 0;

export function threadOrdinal(): number {
  return ++ordinals;
}

/** One message the bot sent, as the demo needs to remember it. */
export type Sent = {
  ordinal: number;
  to: string;
  message: OutboundMessage;
  /** Sim time, for the timestamp on the bubble. */
  at: number;
};

export type OutboundListener = (sent: Sent) => void;

export class DemoTransport implements Transport {
  readonly sent: Sent[] = [];

  private readonly listeners = new Map<string, Set<OutboundListener>>();

  /**
   * The clock is passed as a getter rather than a number because a transport
   * outlives any one sim instant. The domain hands `send()` no timestamp — the
   * `now` it was built with is inside its FlowContext — so the clock's current
   * reading is the closest honest stamp, and it is within one frame of the event
   * that provoked the message.
   */
  constructor(private readonly now: () => number) {}

  /** Watch one number. Returns the detach, which Phase 4's slots will need. */
  listen(phone: string, fn: OutboundListener): () => void {
    const set = this.listeners.get(phone) ?? new Set<OutboundListener>();
    this.listeners.set(phone, set);
    set.add(fn);
    return () => set.delete(fn);
  }

  async send(message: OutboundMessage): Promise<void> {
    renderOutbound(message);

    const record: Sent = {
      ordinal: threadOrdinal(),
      to: message.to,
      message,
      at: this.now(),
    };
    this.sent.push(record);

    // Copied before iterating: a listener that detaches itself on receipt —
    // which is how a slot releases a finished conversation — would otherwise
    // mutate the set mid-loop.
    for (const fn of [...(this.listeners.get(message.to) ?? [])]) fn(record);
  }

  /** Everything ever sent to one number, for rebuilding a thread. */
  to(phone: string): Sent[] {
    return this.sent.filter((s) => s.to === phone);
  }
}
