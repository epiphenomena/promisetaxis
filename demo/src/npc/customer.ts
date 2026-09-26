/**
 * Somebody in Copán who wants a tuktuk.
 *
 * A person, not a script: a name, a number, the corner they are standing on and
 * where they want to go. Everything else — when to send a pin, which row to tap,
 * what to type when the bot has not understood — is decided from the last message
 * the bot sent, one message at a time (§9). That matters beyond tidiness. The hail
 * flow has five states and three ways into the free-text branch, and a customer
 * who replayed a fixed sequence would sail straight past a question the domain had
 * started asking and leave the demo showing a conversation nobody could have.
 *
 * Three ways of naming a destination, because all three are real and each one goes
 * through different code:
 *
 *   taps      the two-tap path the design is built around — a zone row, then a
 *             landmark row
 *   otherRow  "Otro lugar…", then types the name at the prompt
 *   types     ignores the zone menu and types the place, the way a local who has
 *             used the service twice actually behaves — and the way `onFreeText`,
 *             `noMatch` and `confirmMatch` are reached at all
 */

import { copy } from "../../../src/domain/copy";
import { OTHER_PLACE } from "../../../src/domain/customer";
import type { InboundPayload, OutboundSpec } from "../../../src/domain/types";
import type { NpcDeps } from "./npc";
import { ReactiveNpc, rowWithId, rowsOf } from "./npc";

/** How this person names where they are going. */
export type TalkStyle = "taps" | "otherRow" | "types";

export type CustomerPlan = {
  phone: string;
  name: string;
  /** The corner they are standing on. What the pin says. */
  pickup: { lat: number; lng: number };
  /** The zone row they tap on the way to the landmark. */
  destZone: string;
  /** The landmark they are actually going to. */
  destLandmark: string;
  style: TalkStyle;
  /**
   * What they type, in order, when they are typing.
   *
   * More than one entry is a person whose first attempt did not land: the bot
   * answers `noMatch` and they try again with a name it knows. Running out is a
   * person giving up, which is a real outcome and is shown as one.
   */
  typed?: string[];
};

/**
 * How a customer opens. Four ways of saying the same nothing, because this is the
 * one message in the whole flow whose content the domain ignores — any message
 * from an idle number opens the hail — so it is free to sound like people.
 */
const GREETINGS = ["buenas", "buenas tardes", "hola", "necesito un tuktuk"] as const;

export class CustomerNpc extends ReactiveNpc {
  /** What is left of `typed`, consumed as attempts fail. */
  private attempts: string[];

  constructor(
    private readonly plan: CustomerPlan,
    deps: NpcDeps,
  ) {
    super(plan.phone, deps);
    this.attempts = [...(plan.typed ?? [])];
  }

  get name(): string {
    return this.plan.name;
  }

  /** Walk on stage. The greeting is an intention like any other, so R1 holds. */
  arrive(at: number): void {
    this.intend({ kind: "text", text: this.deps.rng.pick(GREETINGS) }, at);
  }

  /** A scripted line — *cancelar*, a nudge — typed by this person at `at`. */
  say(at: number, text: string): void {
    this.intend({ kind: "text", text }, at);
  }

  /**
   * A customer takes a moment longer than a driver.
   *
   * A driver has three buttons in front of them all day; a customer is reading a
   * menu of places for the first time. The difference is what stops four
   * conversations from landing on the same sim second and reading as a machine.
   */
  protected override thinkSpread(): number {
    return 4_200;
  }

  protected consider(spec: OutboundSpec, at: number): void {
    switch (spec.kind) {
      case "locationRequest":
        // Both the greeting's reply and the reminder land here. Sending the pin
        // again is the right answer to both, which is why no state is kept.
        this.intend({ kind: "location", lat: this.plan.pickup.lat, lng: this.plan.pickup.lng }, at);
        return;

      case "list":
        this.pickFromMenu(spec, at);
        return;

      case "text":
        this.answerText(spec.body, at);
        return;

      // A customer is never sent buttons or a pin by this design. If one ever
      // arrives, saying nothing is what a confused person does — and the message
      // is on their phone on screen for anyone to read.
      case "buttons":
      case "location":
        return;
    }
  }

  // ── Menus ──────────────────────────────────────────────────────────────────

  /**
   * Which list is this, and which row.
   *
   * Read off the row ids rather than the wording, so this survives `copy.ts` being
   * rewritten: `zone:` is the zone menu, `lm:` is either the landmark menu or the
   * "did you mean" list, and the two are told apart by whether "Otro lugar…" is
   * among the rows — which is exactly the difference between them in
   * `customer.ts`.
   */
  private pickFromMenu(spec: OutboundSpec, at: number): void {
    const rows = rowsOf(spec);
    if (rows.length === 0) return;

    if (rows[0]!.id.startsWith("zone:")) {
      // A typist skips the menu entirely. `awaiting_zone` accepts free text and
      // routes it to `onFreeText`, and that is the whole free-text branch: a
      // customer who always tapped would never reach it.
      if (this.plan.style === "types") {
        this.type(at);
        return;
      }
      this.tap(spec, `zone:${this.plan.destZone}`, at);
      return;
    }

    if (!rows[0]!.id.startsWith("lm:")) return;

    const escape = rowWithId(spec, `lm:${OTHER_PLACE}`);
    if (this.plan.style === "otherRow" && escape) {
      this.intend({ kind: "list", id: escape.id, title: escape.title }, at);
      return;
    }

    const wanted = rowWithId(spec, `lm:${this.plan.destLandmark}`);
    if (wanted) {
      this.intend({ kind: "list", id: wanted.id, title: wanted.title }, at);
      return;
    }

    // Their place is not on this menu — they tapped the wrong zone, or the bot
    // offered lookalikes and none of them is it. "Otro lugar…" if it is there,
    // and otherwise type the name: both are what a person does, and both are
    // paths the domain has.
    if (escape) {
      this.intend({ kind: "list", id: escape.id, title: escape.title }, at);
      return;
    }
    this.type(at);
  }

  private tap(spec: OutboundSpec, id: string, at: number): void {
    const row = rowWithId(spec, id);
    if (!row) {
      // The zone they wanted is not on the menu, which can only mean the
      // gazetteer changed under them. Typing is the way out a person has.
      this.type(at);
      return;
    }
    this.intend({ kind: "list", id: row.id, title: row.title }, at);
  }

  // ── Words ──────────────────────────────────────────────────────────────────

  private answerText(body: string, at: number): void {
    // Compared against `copy.ts`'s own constants, so rewording the Spanish
    // rewords what this matches. Only the three messages that *ask for* something
    // are here; everything else the bot says to a customer is news, and news is
    // answered with silence.
    if (body === copy.customer.otherPlacePrompt || body === copy.customer.noMatch) {
      this.type(at);
      return;
    }

    // The two endings. Retiring rather than falling quiet is the difference
    // between a finished customer and an infinite trip generator: any message
    // from an idle number opens a fresh hail (`handleCustomer`'s default branch),
    // so an NPC that ever spoke again after this would order another tuktuk.
    if (body === copy.customer.tripDone || body === copy.customer.canceled) {
      this.retire();
    }
  }

  /**
   * Type the next name on the list, or give up.
   *
   * Giving up is a real outcome and the demo shows it: the thread is left with the
   * bot's "no encontré ese lugar" as its last message, which is what a person who
   * put their phone down looks like from the outside. Inventing further attempts
   * until one matched would be the demo flattering the gazetteer.
   */
  private type(at: number): void {
    const next = this.attempts.shift();
    if (next === undefined) {
      this.retire();
      return;
    }
    this.intend({ kind: "text", text: next } satisfies InboundPayload, at);
  }
}
