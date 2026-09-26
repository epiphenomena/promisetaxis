/**
 * A phone: the chrome, the thread, and a renderer for every `OutboundSpec` kind.
 *
 * The thread is a log of messages and nothing else. It holds no idea of whether
 * a trip is pending or assigned, and the driver's status in the header is read
 * back out of the `drivers` table rather than inferred from what went past
 * (R2) — so a status that disagrees with the database is impossible rather
 * than merely unlikely.
 *
 * Everything a person does here — a reply button, a list row, a pin, a typed
 * message — leaves through `queue.push()` and arrives at the domain as an
 * ordinary `InboundEvent` (R1). There is no second path, which is what makes a
 * human indistinguishable from the NPCs Phase 5 adds.
 *
 * And the control that was pressed is shown pressing, which is the same fact read
 * back the other way: `onInbound` runs as an event is drained, so whatever it lights
 * up was chosen by the event and not by whoever caused it. A person tapping ✅ Listo
 * and an NPC tapping it therefore look the same on this glass. `press.ts` has the
 * timing argument.
 *
 * The rendering follows WhatsApp's affordances rather than inventing nicer ones,
 * because the affordances are a constraint the app is designed around: at most
 * three reply buttons attached under a bubble, and a list that is one button
 * opening a sheet. `renderOutbound` in the adapter asserts both limits before a
 * message ever reaches this file, so a menu that outgrew them fails loudly.
 */

import type { Landmark, Zone } from "../../src/domain/places";
import { listLandmarks, listZones } from "../../src/domain/places";
import { formatPhone } from "../../src/domain/roster";
import type { InboundPayload, OutboundSpec } from "../../src/domain/types";
import type { SimClock } from "./clock";
import { formatSimTime } from "./clock";
import { cancelPress, press } from "./press";
import type { Delivered, InboundQueue } from "./queue";
import type { DemoTransport, Sent } from "./transport";

export type PhoneRole = "customer" | "driver";

export type Contact = {
  phone: string;
  /** Shown for customers. A driver's name comes from the roster instead. */
  name: string;
  role: PhoneRole;
};

export type PhoneDeps = {
  db: D1Database;
  clock: SimClock;
  queue: InboundQueue;
  transport: DemoTransport;
};

/**
 * Driver statuses in the header. New chrome labels rather than copy strings —
 * `copy.ts` has no word for a status because the app never shows one to a driver
 * — so they follow its register: plain, courteous, no abbreviations.
 */
const DRIVER_STATUS: Record<string, string> = {
  available: "Disponible",
  assigned: "Asignado",
  on_trip: "En viaje",
  break: "En descanso",
  off: "Fuera de turno",
};

/** WhatsApp's own label on a location-request button, not app copy. */
const SEND_LOCATION = "Enviar ubicación";

/**
 * What a sheet on screen is for: a choice being offered, or one already made.
 *
 * The second is the press showing what a row-tap picked, and it is inert in every
 * sense — no handlers on the rows, and no pointer events on the sheet at all.
 */
type SheetMode = "pick" | "show";

type Side = "in" | "out";

export class Phone {
  readonly el: HTMLElement;

  private readonly thread: HTMLElement;
  private readonly avatar: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly tuktukEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sheet: HTMLElement;
  private readonly sheetTitle: HTMLElement;
  private readonly sheetBody: HTMLElement;
  /** WhatsApp's attachment button: where a pin sent unprompted actually leaves from. */
  private readonly attach: HTMLButtonElement;
  private readonly sendBtn: HTMLButtonElement;

  /**
   * The list sheets this phone has been sent, oldest first.
   *
   * Kept so that a `list` inbound event can be shown as the sheet it came out of
   * rather than as the button that opened it — the row is the choice, and a viewer
   * who only sees "Ver zonas" light up has learnt nothing about which zone. The specs
   * are already in `transport.sent`; held here as well because finding the sheet that
   * offered one row id is a search over rows, not over messages.
   */
  private readonly sheets: Extract<OutboundSpec, { kind: "list" }>[] = [];

  private readonly detach: (() => void)[] = [];

  /** The previous bubble's side, so only the first of a run gets a tail. */
  private lastSide: Side | null = null;

  /**
   * Whether a person is driving this phone.
   *
   * A phone is a mirror by default: it shows what the domain said and taps go
   * nowhere. That is not a decoration — a viewer who tapped ✅ Listo on a phone an
   * NPC was answering would be racing it, and the two of them would interleave
   * into a conversation neither had meant to have. `slots.ts` flips this when
   * somebody takes the wheel, and the affordances go dead in the same breath so
   * the glass never invites a tap it will swallow.
   */
  private live = false;

  /** The gazetteer, fetched once. Landmarks do not change during a demo. */
  private places: { zone: Zone; landmarks: Landmark[] }[] | null = null;

  /** True while `rebuild` is replaying history, so old bubbles do not announce. */
  private replaying = false;

  /**
   * Bumped every time the sheet's contents change.
   *
   * A press that showed a sheet has to put it away again when it ends — but a press
   * lasts 450 real milliseconds, and in that time a person can open a different sheet
   * from a reply that has just landed. Dismissing whatever happens to be open then
   * would shut the menu they were reading. So a press closes the sheet only if it is
   * still the sheet the press was showing, and this counter is how it can tell.
   */
  private sheetEpoch = 0;

  constructor(
    private readonly contact: Contact,
    private readonly deps: PhoneDeps,
  ) {
    this.el = element("article", "phone");
    this.el.dataset.role = contact.role;

    const shell = element("div", "phone__shell");
    this.el.append(shell);

    // ── Header ──────────────────────────────────────────────────────────────
    const bar = element("header", "bar");
    this.avatar = element("span", "bar__avatar");
    this.avatar.textContent = initial(contact.name);
    const who = element("div", "bar__who");
    const nameLine = element("div", "bar__nameline");
    this.nameEl = element("span", "bar__name");
    this.nameEl.textContent = contact.name;
    // The tuktuk number is its own badge rather than a suffix on the phone
    // number: side by side with a status pill they do not both fit in 366px, and
    // the number is the thing a dispatcher says out loud.
    this.tuktukEl = element("span", "bar__tuktuk");
    this.tuktukEl.hidden = true;
    nameLine.append(this.nameEl, this.tuktukEl);
    this.metaEl = element("span", "bar__meta");
    this.metaEl.textContent = formatPhone(contact.phone);
    // A customer nobody has named is labelled with their number, and WhatsApp
    // shows an unknown contact exactly that way — number on the name line and
    // nothing underneath. Printing it twice would read as a rendering bug.
    this.metaEl.hidden = contact.name === this.metaEl.textContent;
    who.append(nameLine, this.metaEl);
    this.statusEl = element("span", "bar__status");
    this.statusEl.textContent = contact.role === "driver" ? "" : "Cliente";
    this.statusEl.dataset.status = contact.role === "driver" ? "off" : "customer";
    bar.append(this.avatar, who, this.statusEl);

    // ── Thread ──────────────────────────────────────────────────────────────
    this.thread = element("div", "thread");
    this.thread.setAttribute("role", "log");
    this.thread.setAttribute("aria-label", `Conversación de ${contact.name}`);

    // ── Composer ────────────────────────────────────────────────────────────
    const composer = element("form", "composer") as HTMLFormElement;
    const attach = button("composer__attach", "+");
    this.attach = attach;
    attach.type = "button";
    attach.title = SEND_LOCATION;
    attach.setAttribute("aria-label", SEND_LOCATION);
    // A driver is never *asked* for a location: `handleDriver` reacts to a pin
    // but never sends a `locationRequest`, so starting a shift means sending one
    // unprompted. WhatsApp's attachment button is where that lives for real, and
    // without it there is no way to begin a shift at all.
    attach.addEventListener("click", () => void this.openLocationSheet());

    this.input = document.createElement("input");
    this.input.className = "composer__input";
    this.input.placeholder = "Escriba un mensaje";
    this.input.autocomplete = "off";

    const sendBtn = button("composer__send", "");
    this.sendBtn = sendBtn;
    sendBtn.append(icon("send"));
    sendBtn.type = "submit";
    sendBtn.setAttribute("aria-label", "Enviar");

    composer.append(attach, this.input, sendBtn);
    composer.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      this.send({ kind: "text", text });
    });

    // ── Sheet ───────────────────────────────────────────────────────────────
    this.sheet = element("div", "sheet");
    this.sheet.hidden = true;
    const scrim = element("div", "sheet__scrim");
    scrim.addEventListener("click", () => this.closeSheet());
    const panel = element("div", "sheet__panel");
    const head = element("header", "sheet__head");
    this.sheetTitle = element("span", "sheet__title");
    const close = button("sheet__close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Cerrar");
    close.addEventListener("click", () => this.closeSheet());
    head.append(this.sheetTitle, close);
    this.sheetBody = element("div", "sheet__body");
    panel.append(head, this.sheetBody);
    this.sheet.append(scrim, panel);

    shell.append(bar, this.thread, composer, this.sheet);

    this.detach.push(
      deps.queue.listen(contact.phone, (d) => this.onInbound(d)),
      deps.transport.listen(contact.phone, (s) => this.onOutbound(s)),
    );

    this.setLive(false);
  }

  /** Phase 4 rotates numbers through slots; a released phone must stop listening. */
  destroy(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
    // A press outlives the frame it started in, and a slot rotating to another number
    // would otherwise leave a timer to run against a thread that is no longer on the
    // page — and, worse, a `done` callback closing a sheet that belongs to whoever
    // took the rectangle over.
    cancelPress(this.contact.phone);
  }

  /** Hand the glass to a person, or take it back. */
  setLive(live: boolean): void {
    this.live = live;
    this.el.dataset.live = String(live);
    this.input.disabled = !live;
    this.syncLive();
    // A sheet left open on a phone that has just gone dead would keep offering
    // rows that do nothing — and a press goes with it, because a row lit inside a
    // sheet that is no longer on screen is a highlight nobody can see and one that
    // would never dismiss the thing it was showing.
    if (!live) {
      this.closeSheet();
      cancelPress(this.contact.phone);
    }
  }

  /**
   * The inert affordances, made inert to the keyboard as well as to the mouse.
   *
   * The stylesheet stops a mouse reaching a reply button on a phone nobody is
   * driving, but `pointer-events: none` says nothing to Tab. Somebody keyboarding
   * through this page would otherwise land on a dozen buttons in a row that take
   * focus, show the focus ring, and do nothing when pressed — which is the same
   * "the button didn't work" that §6 of the plan worries about, arriving through
   * the one input device the styling does not cover. `disabled` is the honest
   * answer: it is what the control actually is.
   *
   * Called after every render, because a spec that arrives while the phone is a
   * mirror brings new buttons with it.
   */
  private syncLive(): void {
    for (const control of this.el.querySelectorAll<HTMLButtonElement>(
      ".action, .composer__attach, .composer__send",
    )) {
      control.disabled = !this.live;
    }
  }

  /**
   * Rebuild the whole thread from what has already been said.
   *
   * A slot adopting a conversation in progress is the normal case, not the odd
   * one: a number earns its slot on its *first* message, and by the time the slot
   * exists the bot has usually already answered. So the thread is the merge of the
   * two traffic logs, ordered by the shared ordinal `transport.ts` mints for
   * exactly this — `at` cannot do it, because a reply carries the sim time of the
   * event that caused it and a paused conversation carries one minute throughout.
   */
  rebuild(): void {
    this.thread.replaceChildren();
    this.lastSide = null;
    // Nothing here is new — it is a conversation being caught up on — and a dozen
    // bubbles all playing the arrival animation at once reads as the page
    // glitching rather than as somebody having said something.
    this.replaying = true;

    const history: { ordinal: number; render: () => void }[] = [
      ...this.deps.queue.to(this.contact.phone).map((d) => ({
        ordinal: d.ordinal,
        render: () => this.onInbound(d),
      })),
      ...this.deps.transport.to(this.contact.phone).map((s) => ({
        ordinal: s.ordinal,
        render: () => this.onOutbound(s),
      })),
    ];

    history.sort((a, b) => a.ordinal - b.ordinal);
    for (const item of history) item.render();
    this.replaying = false;
  }

  /** The thread as plain text, oldest first. The verification harness reads this. */
  threadText(): string[] {
    return [...this.thread.querySelectorAll(".msg")].map((msg) =>
      (msg.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  }

  /**
   * Re-read the header from the roster.
   *
   * Called after a drain rather than every frame, because `handleInbound` and
   * `sweepStuckState` are the only things that can change a driver's row. It goes
   * through the shim rather than `db.sqlite` because the shim caches prepared
   * statements by SQL text — so this is one sql.js statement for the whole demo
   * hour instead of a WASM-side allocation per refresh.
   */
  async refresh(): Promise<void> {
    if (this.contact.role !== "driver") return;

    const row = await this.deps.db
      .prepare("SELECT name, tuktuk_no, status FROM drivers WHERE phone = ?")
      .bind(this.contact.phone)
      .first<{ name: string; tuktuk_no: string | null; status: string }>();
    if (!row) return;

    this.nameEl.textContent = row.name;
    this.avatar.textContent = initial(row.name);
    this.metaEl.textContent = formatPhone(this.contact.phone);
    this.tuktukEl.textContent = row.tuktuk_no ? `#${row.tuktuk_no}` : "";
    this.tuktukEl.hidden = !row.tuktuk_no;
    this.statusEl.textContent = DRIVER_STATUS[row.status] ?? row.status;
    this.statusEl.dataset.status = row.status;
  }

  // ── The one way out ───────────────────────────────────────────────────────

  /**
   * Every tap, row, pin and typed line funnels through here (R1).
   *
   * Scheduled at the current sim instant, so a tap while the clock is paused is
   * delivered on the next frame and stamped with the minute on screen.
   *
   * There is no second, quieter path for a human: what leaves here is the same
   * `InboundEvent` an NPC pushes, with an id from the same counter, and the domain
   * cannot tell which of them it came from. That is the property that makes taking
   * control worth showing at all — a demo with a privileged human path would be
   * demonstrating the demo rather than the app.
   */
  private send(payload: InboundPayload): void {
    // Refused rather than merely unreachable. The affordances go dead when the
    // phone is not live, but a stale closure — a sheet row from before control was
    // handed back — must not be able to slip an event in behind the NPC's back.
    if (!this.live) return;
    this.deps.queue.push(this.deps.clock.now(), this.contact.phone, payload);
  }

  // ── Incoming and outgoing ─────────────────────────────────────────────────

  /** What this person sent, echoed on their own side of the thread. */
  private onInbound({ event }: Delivered): void {
    const payload = event.payload;

    // Withheld while `rebuild` is replaying, for the reason `data-fresh` is: a slot
    // adopting a conversation in progress walks the whole of it through here, and
    // every control the conversation ever touched would light up at once.
    if (!this.replaying) this.showPress(payload);

    if (payload.kind === "location") {
      const bubble = this.bubble("out", { media: true });
      bubble.append(mapCard(payload.lat, payload.lng, null));
      this.finish(bubble, event.at);
      return;
    }

    const text =
      payload.kind === "text"
        ? payload.text
        : payload.kind === "button" || payload.kind === "list"
          ? payload.title
          : payload.description;

    const bubble = this.bubble("out");
    this.text(bubble, text, event.at);
  }

  /** What the bot said, rendered by spec kind. */
  private onOutbound(sent: Sent): void {
    this.renderSpec(sent.message.spec, sent.at);
    // The buttons under a bubble are created here, and on a phone nobody is
    // driving they have to arrive already dead.
    this.syncLive();
    // Scrolled again here rather than only inside the bubble helpers: the actions
    // are attached after the text, so the earlier scroll was measured against a
    // bubble that had not grown its buttons yet.
    this.scroll();
  }

  private renderSpec(spec: OutboundSpec, at: number): void {
    switch (spec.kind) {
      case "text": {
        const bubble = this.bubble("in");
        this.text(bubble, spec.body, at);
        return;
      }

      case "locationRequest": {
        const bubble = this.bubble("in");
        this.text(bubble, spec.body, at);
        const actions = element("div", "msg__actions");
        const send = button("action", SEND_LOCATION);
        send.dataset.tapKind = "location";
        send.prepend(icon("pin"));
        send.addEventListener("click", () => void this.openLocationSheet());
        actions.append(send);
        bubble.append(actions);
        return;
      }

      case "location": {
        const bubble = this.bubble("in", { media: true });
        bubble.append(mapCard(spec.lat, spec.lng, spec.name ?? null));
        this.finish(bubble, at);
        return;
      }

      case "buttons": {
        const bubble = this.bubble("in");
        this.text(bubble, spec.body, at);
        const actions = element("div", "msg__actions");
        // Stacked and full width for any count. WhatsApp allows one, two or
        // three, and the domain sends all three shapes — `drv:resume` alone on a
        // break, done + break from the cron nudge, and the driver's usual trio —
        // so a layout tuned for exactly three would break two real messages.
        for (const b of spec.buttons) {
          const btn = button("action", b.title);
          // The id the domain will read this tap as, on the element. That is what lets
          // a delivered `button` event find the control it came from without the
          // sender having to say which — so an NPC's tap lights the same rectangle a
          // thumb would have.
          btn.dataset.tapId = b.id;
          btn.addEventListener("click", () =>
            this.send({ kind: "button", id: b.id, title: b.title }),
          );
          actions.append(btn);
        }
        bubble.append(actions);
        return;
      }

      case "list": {
        // Remembered before it is drawn, because the sheet has to be reconstructable
        // from a row id when the answer comes back.
        this.sheets.push(spec);
        const bubble = this.bubble("in");
        this.text(bubble, spec.body, at);
        const actions = element("div", "msg__actions");
        const open = button("action", spec.buttonLabel);
        open.dataset.tapKind = "list";
        open.prepend(icon("list"));
        open.addEventListener("click", () => {
          this.openSheet(spec.buttonLabel, (body) => {
            for (const section of spec.sections) {
              if (section.title) {
                const label = element("div", "sheet__section");
                label.textContent = section.title;
                body.append(label);
              }
              for (const row of section.rows) {
                body.append(
                  this.sheetRow(row.title, row.description ?? null, () =>
                    this.send({ kind: "list", id: row.id, title: row.title }),
                  ),
                );
              }
            }
          });
        });
        actions.append(open);
        bubble.append(actions);
        return;
      }
    }

    // A sixth spec kind added to the domain would otherwise render as a blank
    // where a message should be, which is the exact failure the whole
    // reuse-the-domain decision exists to prevent: a demo that silently stops
    // showing what the app does. Narrowing to `never` turns it into a build error.
    const unhandled: never = spec;
    throw new Error(`demo phone: no renderer for spec ${JSON.stringify(unhandled)}`);
  }

  // ── The press ─────────────────────────────────────────────────────────────

  /**
   * Light the control this event came out of.
   *
   * Everything here is read off the payload, which is the point: the `button` id, the
   * `list` row id and the bare fact of a `location` are the same three things the
   * domain switches on, so what lights up is decided by what went in and not by who
   * put it there.
   *
   * The pairings are the ones WhatsApp actually has. A `button` is a reply button
   * under a bubble. A `list` is a *row inside a sheet*, not the button that opens the
   * sheet — the row is the choice, and a viewer who sees only "Ver zonas" flash has
   * been told nothing about which zone. A `location` left either through the button
   * under a `locationRequest` or, when nobody asked, through WhatsApp's own
   * attachment button, which is how a driver starts a shift. A `text` is the send
   * button: not a tap at all but somebody typing, which is a distinction several
   * beats turn on — the free-text fallback and the driver keywords both exist because
   * buttons fail in the field.
   *
   * Two limits are worth stating rather than leaving to be discovered.
   *
   * **A tap whose reply is a burst scrolls its own control off the top.** The press
   * goes on before `handleInbound` runs, so at that instant the control is the newest
   * thing on the glass — and a beat later the reply arrives, the thread scrolls to it
   * the way `scroll()` below argues at length that it must, and a ✅ Listo answered
   * with three bubbles carries the button that caused them out of frame. Both cannot
   * fit, so one of them loses; top-aligning the burst instead was tried and measured,
   * which is what that comment is about, and losing the newest message was worse. The
   * thread's rule therefore wins and the press does not override it: what a viewer sees
   * of a tap with a burst behind it is the burst. Where the reply is a single message —
   * most of them — or where the choice was made in a sheet, which floats over the
   * thread rather than scrolling with it, the press is on screen for its whole 450 ms.
   *
   * **The first message from a number is never lit.** A slot is won by a conversation's
   * opening message, so at the instant that event is delivered there is no phone on
   * screen to light — the `Phone` is built afterwards, by `board.observe`, and
   * `rebuild` replays the message with `replaying` set. Nothing is hidden there: a
   * shift-start pin really was sent from a WhatsApp nobody was looking at yet.
   */
  private showPress(payload: InboundPayload): void {
    // Ended before anything is built. `press` would end it anyway, but a row press
    // rebuilds the sheet first, and a cancellation arriving after that would close
    // the sheet this press had just opened.
    cancelPress(this.contact.phone);

    switch (payload.kind) {
      case "button": {
        // No sheet to put away, and deliberately no callback that would: a reply
        // button is tapped from the thread, so a press that dismissed a sheet on
        // expiry would be reaching into an interaction it had nothing to do with.
        const el = this.lastInThread(`.action[data-tap-id="${payload.id}"]`);
        if (el) press(this.contact.phone, el, "button", payload.title);
        return;
      }

      case "list": {
        this.showPickedRow(payload.id, payload.title);
        return;
      }

      case "location": {
        // Nothing to put away: a pin picked by a person closed the place picker on the
        // way out, and a pin sent by an NPC never opened one. The affordance lit is the
        // button under the bot's request, or WhatsApp's attachment button when nobody
        // asked — which is how a driver starts a shift.
        const asked = this.lastInThread('.action[data-tap-kind="location"]');
        press(this.contact.phone, asked ?? this.attach, "location", SEND_LOCATION);
        return;
      }

      case "text":
        press(this.contact.phone, this.sendBtn, "send", payload.text);
        return;
    }
  }

  /** A callback that closes the sheet as it is now, and leaves a later one alone. */
  private dismissSheet(): () => void {
    const epoch = this.sheetEpoch;
    return () => {
      if (this.sheetEpoch === epoch) this.closeSheet();
    };
  }

  /**
   * The sheet the row was picked from, back on screen with the row marked.
   *
   * Built here rather than left standing, and that is what makes a person's pick and
   * an NPC's the same picture: an NPC never opened a sheet at all, and a person's
   * closed on the way out because a sheet covers the phone it belongs to. What both
   * get is this — the same rows, the chosen one lit, none of them live — put up as the
   * event is delivered and taken down when the press ends, however it ends.
   */
  private showPickedRow(id: string, title: string): void {
    const spec = [...this.sheets].reverse().find((s) => rowIds(s).includes(id));
    if (!spec) return;

    // Built before the sheet is shown rather than inside the builder, so the row that
    // was chosen is an ordinary local and not something recovered from the DOM by
    // matching on its text.
    const children: HTMLElement[] = [];
    let marked: HTMLButtonElement | null = null;
    for (const section of spec.sections) {
      if (section.title) {
        const label = element("div", "sheet__section");
        label.textContent = section.title;
        children.push(label);
      }
      for (const row of section.rows) {
        // No handler on any of them: this sheet is a picture of a choice already made,
        // and a second pick from it would be an event the person never sent.
        const el = this.sheetRow(row.title, row.description ?? null, null);
        if (row.id === id) marked = el;
        children.push(el);
      }
    }

    this.showSheet(spec.buttonLabel, (body) => body.append(...children), "show");
    if (!marked) return;
    // The callback is made *after* the sheet is shown, so the epoch it captures is
    // this sheet's and not the one it replaced.
    press(this.contact.phone, marked, "row", title, this.dismissSheet());
    // A zone menu is short and a landmark menu is not, so the row that was chosen may
    // be below the fold of a sheet that has just been rebuilt from the top.
    marked.scrollIntoView({ block: "nearest" });
  }

  /** The newest matching control in the thread — the message that was answered. */
  private lastInThread(selector: string): HTMLElement | null {
    const found = this.thread.querySelectorAll<HTMLElement>(selector);
    return found.length === 0 ? null : found[found.length - 1]!;
  }

  // ── Bubbles ───────────────────────────────────────────────────────────────

  /**
   * A new bubble, appended and returned so the caller can fill it.
   *
   * `media` bubbles hold a card edge to edge with the timestamp floated over it,
   * which is how WhatsApp renders a shared pin; text bubbles reserve room for the
   * timestamp on the last line instead.
   */
  private bubble(side: Side, opts: { media?: boolean } = {}): HTMLElement {
    const wrap = element("div", `msg msg--${side}`);
    // Only the first bubble of a run carries a tail — the detail that makes a
    // WhatsApp thread read as a conversation instead of a list.
    if (this.lastSide !== side) wrap.classList.add("msg--head");
    if (opts.media) wrap.classList.add("msg--media");
    // Four conversations run at once on this page and three of them are usually
    // somebody else's. The attribute is what the stylesheet animates once, on
    // insertion, so the eye is told which rectangle just spoke; there is no timer
    // to clear and nothing to undo, and `prefers-reduced-motion` switches it off.
    if (!this.replaying) wrap.dataset.fresh = "";
    this.lastSide = side;

    const bubble = element("div", "msg__bubble");
    wrap.append(bubble);
    this.thread.append(wrap);
    this.scroll();
    return bubble;
  }

  /** The bubble's text, with `*bold*` honoured and the timestamp tucked in. */
  private text(bubble: HTMLElement, body: string, at: number): void {
    const block = element("div", "msg__text");
    const span = element("span", "msg__body");
    span.append(formatBody(body));
    // An empty inline-block the width of the timestamp, so a long last line wraps
    // around it instead of running underneath.
    block.append(span, element("span", "msg__pad"), stamp(at));
    bubble.append(block);
    this.scroll();
  }

  /** Timestamp for a bubble whose content is a card rather than text. */
  private finish(bubble: HTMLElement, at: number): void {
    bubble.append(stamp(at));
    this.scroll();
  }

  /**
   * To the end, as WhatsApp does — and this is a decision, not a default.
   *
   * The bot answers in bursts. Refusing a mid-trip ☕ Descanso sends the refusal
   * and then `sendStatus` re-sends the open trip card; a driver coming free gets
   * three bubbles at once. So the obvious improvement is to scroll to the top of
   * the newest *run* instead, and it was tried: it makes the two-message beats
   * legible on a short phone and it is wrong. When a burst does not fit, whichever
   * end is chosen, something is lost — and top-aligning loses the *newest*
   * message, which on a driver's phone is the trip card carrying the ✅ Listo he is
   * supposed to tap. Measured across the scripted hour it hid that card on two of four
   * phones for most of the morning.
   *
   * There is no scroll rule that shows a burst taller than the glass. The glass
   * has to be big enough, which is what `--phone-h` and the composition around it
   * are for, and `verify-phase6.ts` measures the tallest burst of the hour against
   * it so that a copy string growing past what fits fails a check rather than
   * quietly playing off-screen.
   */
  private scroll(): void {
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  // ── Sheets ────────────────────────────────────────────────────────────────

  /** A sheet a thumb can use. Refused on a phone nobody is driving. */
  private openSheet(title: string, build: (body: HTMLElement) => void): void {
    if (!this.live) return;
    this.showSheet(title, build, "pick");
  }

  /**
   * The sheet, built and shown, with no opinion about who asked.
   *
   * Split out from `openSheet` for the press: a phone nobody is driving has to be
   * able to show the row its NPC just picked, and that is the one sheet on this page
   * that opens without a thumb. What keeps it honest is that it is `showPickedRow`
   * calling, off a delivered event, with rows that carry no handler — so an inert
   * phone gains a picture and not an affordance.
   */
  private showSheet(title: string, build: (body: HTMLElement) => void, mode: SheetMode): void {
    this.sheetEpoch += 1;
    // Read by the stylesheet, which takes pointer events away from a sheet in "show".
    // That is not decoration: a sheet is `inset: 0` over the whole phone, so a picture
    // of a choice already made would otherwise swallow the next 450 ms of taps on the
    // thread underneath it — including, on a driver's phone, the ✅ Listo he is being
    // asked for. A picture must not intercept anything.
    this.sheet.dataset.mode = mode;
    this.sheetTitle.textContent = title;
    this.sheetBody.replaceChildren();
    build(this.sheetBody);
    this.sheet.hidden = false;
  }

  private closeSheet(): void {
    this.sheetEpoch += 1;
    this.sheet.hidden = true;
  }

  /**
   * One row. `onPick` of `null` is a row being shown rather than offered.
   *
   * A pick dismisses the sheet at once, and it has to: the sheet is `inset: 0` over
   * the whole phone, so a sheet left up is a phone whose thread cannot be tapped.
   * What a viewer sees of a list choice is not this sheet lingering — it is the one
   * `showPickedRow` puts back a frame later, built from the delivered event, with the
   * row marked and every row of it dead. Which is also how an NPC's pick is shown, so
   * the two are the same picture.
   */
  private sheetRow(
    title: string,
    description: string | null,
    onPick: (() => void) | null,
  ): HTMLButtonElement {
    const row = button("sheet__row", "");
    row.type = "button";
    const label = element("span", "sheet__row-label");
    const name = element("span", "sheet__row-title");
    name.textContent = title;
    label.append(name);
    if (description) {
      const desc = element("span", "sheet__row-desc");
      desc.textContent = description;
      label.append(desc);
    }
    row.append(label, element("span", "sheet__row-mark"));
    if (!onPick) {
      row.disabled = true;
      return row;
    }
    row.addEventListener("click", () => {
      this.closeSheet();
      onPick();
    });
    return row;
  }

  /**
   * The place picker behind 📍.
   *
   * A curated list rather than a draggable map: the demo's whole point is the
   * dispatch decision, and the landmarks come from the seeded gazetteer, so every
   * pin is one the zone matrix actually has travel times for.
   */
  private async openLocationSheet(): Promise<void> {
    if (!this.live) return;
    const places = await this.loadPlaces();
    this.openSheet(SEND_LOCATION, (body) => {
      for (const { zone, landmarks } of places) {
        const label = element("div", "sheet__section");
        label.textContent = zone.name;
        body.append(label);
        for (const lm of landmarks) {
          const lat = lm.lat!;
          const lng = lm.lng!;
          body.append(
            this.sheetRow(lm.name, `${lat.toFixed(4)}, ${lng.toFixed(4)}`, () =>
              this.send({ kind: "location", lat, lng }),
            ),
          );
        }
      }
    });
  }

  private async loadPlaces(): Promise<{ zone: Zone; landmarks: Landmark[] }[]> {
    if (this.places) return this.places;

    const zones = await listZones(this.deps.db);
    const loaded: { zone: Zone; landmarks: Landmark[] }[] = [];
    for (const zone of zones) {
      // Landmarks with no coordinates cannot be sent as a pin at all — the seed
      // gives every one of them a pair, but the column is nullable and a future
      // gazetteer edit could leave one blank.
      const landmarks = (await listLandmarks(this.deps.db, zone.id)).filter(
        (lm) => lm.lat !== null && lm.lng !== null,
      );
      if (landmarks.length) loaded.push({ zone, landmarks });
    }

    this.places = loaded;
    return loaded;
  }
}

// ── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Every row id a list sheet offered, sections flattened.
 *
 * A local four lines rather than `npc/npc.ts`'s `rowsOf`, because the dependency
 * would run the wrong way: the chrome is what the cast reads, not the other way
 * about, and a phone that imported an NPC helper could not be built without one.
 */
function rowIds(spec: Extract<OutboundSpec, { kind: "list" }>): string[] {
  return spec.sections.flatMap((section) => section.rows.map((row) => row.id));
}

/**
 * WhatsApp's `*bold*`, the only markup `copy.ts` uses.
 *
 * Mirrored here so the nonprofit's staff see their wording emphasised the way it
 * will be on a real phone — a copy string reviewed as literal asterisks reads
 * differently from one reviewed as bold.
 *
 * Exported for the ticker, which quotes the same copy — *cancelar*, *menu* — and
 * would otherwise print the asterisks and look like a bug in the wording.
 */
export function formatBody(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\*[^*\n]+\*)/g)) {
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(1, -1);
      frag.append(strong);
    } else if (part) {
      frag.append(document.createTextNode(part));
    }
  }
  return frag;
}

function stamp(at: number): HTMLElement {
  const time = document.createElement("time");
  time.className = "msg__time";
  time.textContent = formatSimTime(at);
  return time;
}

/**
 * A shared pin, as a small map card.
 *
 * Stylized rather than a real tile: no network is allowed (the built demo has to
 * open from `file://`), and the app does not use a tile map either. The street
 * layout is derived from the pin's own coordinates, so two different places look
 * like two different places with no randomness involved — Phase 3 replaces this
 * with a view onto the real town SVG.
 */
function mapCard(lat: number, lng: number, caption: string | null): HTMLElement {
  const card = element("figure", "pin");

  const art = element("div", "pin__art");
  art.innerHTML = mapSvg(lat, lng);
  card.append(art);

  const foot = element("figcaption", "pin__foot");
  if (caption) {
    const name = element("span", "pin__name");
    name.textContent = caption;
    foot.append(name);
  }
  const coords = element("span", "pin__coords");
  coords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  foot.append(coords);
  card.append(foot);

  return card;
}

function mapSvg(lat: number, lng: number): string {
  // Six stable digits of each coordinate, spread across the card. Deterministic
  // by construction: the same place always draws the same streets.
  const jog = (v: number, span: number): number =>
    Math.round(((Math.abs(Math.round(v * 1e6)) % 997) / 997) * span);

  const ax = 26 + jog(lng, 44);
  const bx = 150 + jog(lat, 52);
  const ay = 30 + jog(lat, 26);
  const by = 82 + jog(lng, 22);

  return `<svg viewBox="0 0 240 132" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <rect width="240" height="132" fill="var(--map-ground)"/>
  <g fill="var(--map-block)">
    <rect x="${ax - 22}" y="${ay - 22}" width="40" height="34" rx="2"/>
    <rect x="${bx - 30}" y="${by - 26}" width="46" height="30" rx="2"/>
    <rect x="${ax + 30}" y="${by + 6}" width="52" height="26" rx="2"/>
    <rect x="${bx + 24}" y="${ay - 18}" width="34" height="38" rx="2"/>
  </g>
  <g stroke="var(--map-road)" stroke-width="7" stroke-linecap="square">
    <path d="M0 ${ay} H240"/>
    <path d="M0 ${by} H240"/>
    <path d="M${ax} 0 V132"/>
    <path d="M${bx} 0 V132"/>
  </g>
  <path d="M0 ${by + 34} Q 70 ${by + 12} 120 ${by + 30} T 240 ${by + 18}"
        fill="none" stroke="var(--map-water)" stroke-width="9"/>
  <g transform="translate(120 58)">
    <ellipse cx="0" cy="20" rx="11" ry="4" fill="rgba(0,0,0,0.25)"/>
    <path d="M0 19 C -12 4 -13 -3 -13 -7 A 13 13 0 0 1 13 -7 C 13 -3 12 4 0 19 Z"
          fill="var(--map-pin)"/>
    <circle cx="0" cy="-7" r="4.6" fill="var(--map-ground)"/>
  </g>
</svg>`;
}

// ── Tiny DOM helpers ────────────────────────────────────────────────────────

/**
 * The chrome's own glyphs, drawn rather than borrowed from the emoji table.
 *
 * The emoji in `copy.ts` are the app's voice and must render as emoji; these are
 * interface furniture and would read as a second, louder voice competing with it.
 */
function icon(name: "pin" | "list" | "send"): SVGSVGElement {
  const paths: Record<string, string> = {
    pin: "M12 2a7 7 0 0 0-7 7c0 5.1 7 12.5 7 12.5S19 14.1 19 9a7 7 0 0 0-7-7Zm0 9.4A2.4 2.4 0 1 1 12 6.6a2.4 2.4 0 0 1 0 4.8Z",
    list: "M4 6.5h16v2H4v-2Zm0 4.5h16v2H4v-2Zm0 4.5h16v2H4v-2Z",
    send: "M3.2 20.4 21.5 12 3.2 3.6 3.2 10l12.4 2-12.4 2v6.4Z",
  };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]!);
  svg.append(path);
  return svg;
}

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function button(className: string, label: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = className;
  el.type = "button";
  el.textContent = label;
  return el;
}

function initial(name: string): string {
  // "Don José" should read J, not D — the honorific is not the person.
  const words = name.split(/\s+/).filter((w) => w.length > 0 && !/^(don|doña|dona)$/i.test(w));
  return (words[0] ?? name).slice(0, 1).toUpperCase();
}
