/**
 * Showing the control that was pressed, at the moment the press goes in.
 *
 * The whole reason to watch this page rather than read a transcript of it is that
 * the interaction is legible. Before this, it was half legible: an NPC's answer
 * simply materialised — a bubble appeared on their side of the thread and the
 * conversation moved on — and *which* of the three buttons under the last message
 * they had touched was not on screen anywhere. The reply was visible and the choice
 * was not, which is the wrong half.
 *
 * Three properties keep it from becoming a second, quieter way of driving the page.
 *
 * **It is derived, not driven.** `phone.ts` calls in here from its `queue.listen`
 * callback, which runs as the event is drained and before `handleInbound` has seen
 * it — so the highlight is a *reading* of a delivered `InboundEvent`, one beat ahead
 * of the reply it will cause (R2). No NPC can ask for a highlight; an NPC pushes an
 * event like everybody else. A person's tap and an NPC's therefore look identical on
 * screen, which is the honest picture, because the domain cannot tell them apart
 * either (R1).
 *
 * **It is real time, and nothing else is.** A tap and its reply happen inside one
 * drain, at one sim instant, so there is no sim duration to give this: the flash is
 * an affordance of the interface and not an event in the town. `setTimeout` is the
 * entire mechanism, no wall clock is read, and all it ever does is set an attribute
 * and remove it — so nothing here can reach the trace R4 is judged on.
 *
 * **One press per phone, newest wins.** At 30× a sim minute is two real seconds and
 * an NPC's think-time is often a fraction of one, so two consecutive taps can be
 * tens of milliseconds apart. A duration tuned to fit between them would have to be
 * too short to see, and a duration long enough to see would smear three taps into a
 * lit-up phone. Cancelling the phone's previous press instead makes "no smearing"
 * true by construction: at any instant at most one control per phone is lit, and it
 * is the one that was pressed last. At 4× the flash plays out in full; at 30× it is
 * cut short by the next one, which is exactly what should happen.
 */

/** What kind of affordance was pressed. Reported to the verification harness. */
export type PressKind = "button" | "row" | "location" | "send";

/**
 * How long a press stays lit, in real milliseconds.
 *
 * Long enough to read across a room and short enough that at 4× — the speed the
 * demo is narrated at — it has finished before the next message arrives. It is also
 * what a screenshot has to catch, which is why the harness can end a press on
 * demand rather than racing it.
 */
const HOLD_MS = 450;

type Press = {
  phone: string;
  kind: PressKind;
  /** The control's own words, so a harness can say which one lit up. */
  label: string;
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  /** Run when the press ends however it ends — cancelled, cleared or expired. */
  done: () => void;
};

/** The live press per phone. At most one, which is the no-smearing rule. */
const lit = new Map<string, Press>();

/** One control, lit for `HOLD_MS`. Ends any press the same phone already had. */
export function press(
  phone: string,
  el: HTMLElement,
  kind: PressKind,
  label: string,
  done: () => void = () => {},
): void {
  cancelPress(phone);

  const entry: Press = {
    phone,
    kind,
    label,
    el,
    done,
    timer: setTimeout(() => end(phone), HOLD_MS),
  };
  lit.set(phone, entry);
  // The attribute and not a class, to match the way `phone.ts` marks an arriving
  // bubble: the stylesheet owns what a pressed control looks like, including what it
  // looks like to somebody who asked for less motion.
  el.dataset.pressed = "";
}

/**
 * End one phone's press now.
 *
 * Called when the same phone presses again, when its `Phone` is torn down — a slot
 * rotating to another number must not leave a timer writing into a detached tree —
 * and by the harness before a screenshot that is about something else.
 */
export function cancelPress(phone: string): void {
  const entry = lit.get(phone);
  if (!entry) return;
  clearTimeout(entry.timer);
  finish(entry);
}

/** End every press. The harness's way of making a screenshot say one thing. */
export function clearPresses(): void {
  for (const phone of [...lit.keys()]) cancelPress(phone);
}

/** What is lit right now. Read-only, and the harness's evidence that it was. */
export function activePresses(): { phone: string; kind: PressKind; label: string }[] {
  return [...lit.values()].map(({ phone, kind, label }) => ({ phone, kind, label }));
}

function end(phone: string): void {
  const entry = lit.get(phone);
  if (entry) finish(entry);
}

function finish(entry: Press): void {
  lit.delete(entry.phone);
  delete entry.el.dataset.pressed;
  // Last, because it is where the sheet a row was picked from gets closed, and that
  // has to happen whether the press expired or was cut short by the next tap.
  entry.done();
}
