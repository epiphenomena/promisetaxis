/**
 * The sim clock. One instant for the whole demo.
 *
 * Sim time is not wall time and is never derived from it (R4). The clock holds
 * an accumulator of sim milliseconds and is advanced by explicit deltas, so the
 * same sequence of ticks always produces the same sequence of `now` values —
 * which is what makes a beat that demos well at 09:14 reachable again. Reading
 * `Date.now()` here instead would make the hour drift with the frame rate
 * and the hour it was opened, and R4 would be unenforceable everywhere else.
 *
 * Real elapsed time enters in exactly one place, and it is not here: the tick
 * loop in `main.ts` subtracts consecutive `requestAnimationFrame` timestamps and
 * hands the result to `advance()`.
 */

/**
 * 09:00, the minute the scripted hour opens. The same instant as `T0` in
 * `verify-phase1.ts` on purpose: both scripts drive the same domain, so a wait
 * quote logged by one should be comparable to the other's without arithmetic.
 */
export const SIM_EPOCH = 1_699_952_400_000;

export const MINUTE_MS = 60_000;

/**
 * Time compressions the demo offers, as the multiplier each button carries.
 *
 * 12× puts the scripted hour in five minutes and 30× in two — one sim minute every
 * two real seconds, which is the "show somebody the shape of it" speed. 30× is the
 * fastest the rest of the page can carry: `MAX_FRAME_MS` below caps a frame at 250
 * real ms, so one frame moves sim time by 7.5 seconds, and a conversation still
 * advances at most one message per frame because an NPC's intention is enqueued by
 * `cast.tick` *before* the drain rather than during it.
 */
export const SPEEDS = [1, 4, 12, 30] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * The longest real frame the clock will believe.
 *
 * A backgrounded tab delivers one frame after several seconds, and at 30× that
 * would jump sim time by minutes — skipping past the cron sweep's cadence and
 * dumping a pile of queued events into a single drain. Clamping loses real time
 * rather than sim fidelity, which is the right trade for something being watched.
 */
const MAX_FRAME_MS = 250;

export class SimClock {
  /** Whole sim milliseconds since `SIM_EPOCH`. Integral so `now` never has a fraction. */
  private elapsed = 0;
  /** The sub-millisecond remainder, carried so 1× is not silently rounded away. */
  private carry = 0;
  /**
   * 4× to start, because the scripted hour is an hour of town time.
   *
   * At 1× that is an hour of the viewer's, which is an installation and not a
   * demo; at 12× a conversation is four messages a second and unreadable. 4× puts
   * the whole hour in a quarter of an hour with a message every couple of seconds,
   * which is about the pace somebody can follow while being talked to over it. The
   * others are still one click away, and that is what they are for: 1× to stop on a
   * single exchange, the fast ones to see the shape of the hour at once.
   */
  private speed: Speed = 4;
  private running = false;

  /** Epoch milliseconds, the shape `FlowContext.now` wants. */
  now(): number {
    return SIM_EPOCH + this.elapsed;
  }

  isRunning(): boolean {
    return this.running;
  }

  currentSpeed(): Speed {
    return this.speed;
  }

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  toggle(): void {
    this.running = !this.running;
  }

  /**
   * Back to 09:00, stopped.
   *
   * Added for Phase 5's "run the hour again" control. A fresh `SimClock` per run
   * would be tidier in isolation, but the clock is held by the transport, the
   * slots and every phone on the page, so replacing the object would mean
   * rebuilding things that have nothing to do with the hour being restarted. The
   * speed is deliberately left alone: a viewer who chose 12× meant it.
   */
  reset(): void {
    this.elapsed = 0;
    this.carry = 0;
    this.running = false;
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
  }

  /**
   * Advance by one frame's worth of real time, returning the sim ms gained.
   *
   * Paused means frozen, not slowed — the tick loop still drains the queue while
   * paused, so a tap lands immediately and its reply is stamped with the same
   * sim minute. Anything scheduled for later simply waits for ▶.
   */
  advance(realMs: number): number {
    if (!this.running) return 0;
    const capped = Math.min(Math.max(realMs, 0), MAX_FRAME_MS);
    const total = this.carry + capped * this.speed;
    const whole = Math.floor(total);
    this.carry = total - whole;
    this.elapsed += whole;
    return whole;
  }
}

/**
 * Sim time as a 24-hour clock face.
 *
 * Arithmetic rather than `Date`, because `toLocaleTimeString` would read the
 * host's time zone and the demo would open at 09:00 in Copán and 03:00 in
 * Sydney. The epoch is chosen so plain UTC arithmetic gives the wanted face.
 */
export function formatSimTime(at: number): string {
  const minutes = Math.floor(at / MINUTE_MS) % (24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
