/**
 * What every NPC on this page has in common.
 *
 * The cast is **reactive, not scripted-blind** (§9): an NPC reads the last thing
 * the bot said to its number and decides what to tap next. Nothing knows the
 * order of a conversation in advance, which is why the same NPC can be dropped
 * into a flow that has changed under it — a new question, a menu with different
 * rows, a refusal — and will either answer sensibly or give up, the way a person
 * would. That property is also what makes the cast a crude fuzzer: a copy change
 * that breaks a flow shows up as an NPC that stops answering, on screen, at the
 * minute it happened.
 *
 * Two rules the whole design rests on, both of which look like details:
 *
 * **An intention is held here, not on the queue.** When an NPC decides what to
 * do, it writes down `{ due, payload }` and waits. `tick()` is the only place an
 * event is ever enqueued, and it asks `HumanControl.isHuman()` at that moment and
 * not before — so a phone somebody took the wheel of in the last two sim-seconds
 * does not answer itself behind their back. Pushing straight onto the queue with
 * a future timestamp would be simpler and would lose exactly that.
 *
 * **Think-time is measured from the domain's clock, not the page's.** The anchor
 * is `queue.runningAt` — the sim instant the domain is running at — and the event
 * is enqueued stamped with that anchor plus the think-time, to the millisecond.
 * Using the wall-driven sim clock instead would make an NPC's decisions depend on
 * the frame rate, and with them the trips, the quotes and the learned travel
 * times: R4 would hold for the PRNG and quietly fail for everything downstream.
 */

import type { InboundPayload, OutboundSpec } from "../../../src/domain/types";
import type { InboundQueue } from "../queue";
import type { Rng } from "../rng";
import type { HumanControl, Npc, NpcDirectory } from "../slots";
import type { DemoTransport, Sent } from "../transport";

export type NpcDeps = {
  queue: InboundQueue;
  transport: DemoTransport;
  control: HumanControl;
  /**
   * The cast's own PRNG stream, separate from the fleet's.
   *
   * Sharing one stream would mean that a viewer taking control of a phone —
   * which stops that NPC drawing think-times — shifted every later trip's
   * duration jitter. Two streams from one seed keep the drives identical whether
   * or not anybody touched the page.
   */
  rng: Rng;
};

/** What an NPC has decided to do, and when it will have finished thinking. */
type Intention = { due: number; payload: InboundPayload };

/**
 * How long an NPC takes to answer, in sim milliseconds.
 *
 * Floored well above zero on purpose. A drain re-checks the queue after every
 * delivery so a handler can schedule more work, which is how a conversation
 * proceeds — but an NPC that answered at the same instant it was asked would
 * spin that loop until `MAX_PER_DRAIN` cut it off, and the symptom is a page
 * that stutters rather than an error anybody can read.
 */
const THINK_FLOOR_MS = 800;

/**
 * How many times one NPC will answer before it stops.
 *
 * Not a conversation length — a hail is four or five messages and the busiest
 * NPC here sends eight. This is the guard against a flow that has started
 * answering its own question: two parties each replying politely forever is a
 * live-lock the page cannot show as anything but a frozen minute.
 */
const MAX_TURNS = 24;

export abstract class ReactiveNpc implements Npc {
  private intention: Intention | null = null;
  private detach: (() => void) | null = null;
  private turns = 0;
  /** Set once the conversation is genuinely over. Nothing wakes an NPC from this. */
  private retired = false;

  constructor(
    readonly phone: string,
    protected readonly deps: NpcDeps,
  ) {
    this.detach = deps.transport.listen(phone, (sent) => this.heard(sent));
  }

  /** The hour being restarted takes the whole cast down with it. */
  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.intention = null;
    this.retired = true;
  }

  /**
   * Somebody took the wheel. Drop whatever was half-decided.
   *
   * A courtesy and not the decision: `isHuman()` is asked again in `tick()`, so
   * an NPC whose `suspend` was never called still cannot act on a phone a person
   * is holding. Dropping the intention is what keeps a reply the NPC had already
   * formed from landing two sim-seconds into somebody else's sentence.
   */
  suspend(_at: number): void {
    this.intention = null;
  }

  /**
   * Take over again by re-reading the last thing the bot said.
   *
   * Deliberately not "resume the plan": in between, the person may have answered
   * the question, cancelled the trip, or asked something new. The last outbound
   * message is the only state that survives a hand-over in both directions, which
   * is exactly why the NPCs read it rather than keeping a script pointer.
   */
  resume(at: number): void {
    if (this.retired) return;
    const heard = this.deps.transport.to(this.phone);
    const last = heard[heard.length - 1];
    if (last) this.consider(last.message.spec, at);
  }

  /**
   * The one place an NPC enters the system (R1).
   *
   * Stamped with `due` rather than with `now`: `due` is the instant the NPC
   * finished thinking, and the queue delivers anything already due, so the domain
   * sees the exact time no matter which frame noticed it. That is what makes the
   * hour byte-identical across runs whose frames fell differently.
   */
  tick(now: number): void {
    const intention = this.intention;
    if (!intention || now < intention.due) return;
    this.intention = null;
    if (this.deps.control.isHuman(this.phone)) return;
    this.deps.queue.push(intention.due, this.phone, intention.payload);
  }

  /** Whether this NPC has anything left to do. The scenario's end condition. */
  get idle(): boolean {
    return this.intention === null;
  }

  // ── For subclasses ─────────────────────────────────────────────────────────

  /**
   * Decide to do one thing, `at` being the sim instant of whatever prompted it.
   *
   * Overwrites any earlier intention rather than queueing behind it. A person who
   * is asked a second question answers the second one; keeping a backlog would
   * have an NPC replying to a menu two messages after it was replaced.
   */
  protected intend(payload: InboundPayload, at: number): void {
    if (this.retired) return;
    if (this.turns >= MAX_TURNS) {
      this.retire();
      return;
    }
    this.turns += 1;
    this.intention = { due: at + this.think(), payload };
  }

  /** Stop for good. What a person does when the bot stops making sense. */
  protected retire(): void {
    this.retired = true;
    this.intention = null;
  }

  protected get finished(): boolean {
    return this.retired;
  }

  /** What to do about one message from the bot. */
  protected abstract consider(spec: OutboundSpec, at: number): void;

  /**
   * The sim instant to measure think-time from.
   *
   * `runningAt` is the domain's own `now` for the message being answered.
   * `sent.at` is the clock's reading when the transport recorded it, which is the
   * frame's instant — used only for a message no inbound event caused, which in
   * practice means the cron sweep.
   */
  private anchor(sent: Sent): number {
    return this.deps.queue.runningAt ?? sent.at;
  }

  private think(): number {
    return Math.round(THINK_FLOOR_MS + this.deps.rng.range(0, this.thinkSpread()));
  }

  /** How much longer than the floor this kind of person takes. Sim milliseconds. */
  protected thinkSpread(): number {
    return 3_000;
  }

  private heard(sent: Sent): void {
    if (this.retired) return;
    // Asked here as well as in `tick` so that a phone under human control does
    // not even form intentions while somebody is typing into it. `tick` is still
    // where the authority lies, because control can change in between.
    if (this.deps.control.isHuman(this.phone)) return;
    this.consider(sent.message.spec, this.anchor(sent));
  }
}

// ── The cast ─────────────────────────────────────────────────────────────────

/**
 * Everyone the scenario has brought on, in the order they arrived.
 *
 * Insertion-ordered because `tick` walks it: two NPCs whose think-times expire on
 * the same frame must enqueue in the same order every run, and a Set of objects
 * iterated in creation order is the cheapest way to guarantee it.
 *
 * Doubles as the `NpcDirectory` `HumanControl` asks for, so taking control of any
 * number on the page finds the right NPC to suspend — including a number no slot
 * is currently showing.
 */
export class Cast implements NpcDirectory {
  private readonly members = new Map<string, ReactiveNpc>();

  add<T extends ReactiveNpc>(npc: T): T {
    this.members.set(npc.phone, npc);
    return npc;
  }

  npcFor(phone: string): Npc | null {
    return this.members.get(phone) ?? null;
  }

  tick(now: number): void {
    for (const npc of this.members.values()) npc.tick(now);
  }

  /** True when nobody is mid-thought. With the queue empty, the script is spent. */
  get quiet(): boolean {
    for (const npc of this.members.values()) if (!npc.idle) return false;
    return true;
  }

  dispose(): void {
    for (const npc of this.members.values()) npc.dispose();
    this.members.clear();
  }
}

// ── Reading a menu ───────────────────────────────────────────────────────────

/**
 * Every row of a list spec, sections flattened.
 *
 * NPCs decide *which* menu they are looking at from the row ids — `zone:`,
 * `lm:`, `bzone:` — rather than from the body text. The prefixes are the
 * domain's own contract with itself (`customer.ts` and `driver.ts` both switch on
 * them), so an NPC keyed on them keeps working when the Spanish is reworded,
 * which is the change the nonprofit's staff are expected to make.
 */
export function rowsOf(spec: OutboundSpec): { id: string; title: string }[] {
  if (spec.kind !== "list") return [];
  return spec.sections.flatMap((section) => section.rows);
}

export function rowWithId(
  spec: OutboundSpec,
  id: string,
): { id: string; title: string } | null {
  return rowsOf(spec).find((row) => row.id === id) ?? null;
}
