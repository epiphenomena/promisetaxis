/**
 * The adapter boundary.
 *
 * Everything in `src/domain` speaks only these types. No WhatsApp JSON shape,
 * no Meta field name, and no `fetch` call may appear behind this line — that is
 * what lets the whole dispatch system be tested with no network and no phones,
 * and what makes the fake-WhatsApp harness a drop-in transport.
 *
 * Two functions cross the boundary, both in `src/adapters/whatsapp`:
 *   parseInbound(webhookJson) -> InboundEvent[]
 *   renderOutbound(OutboundMessage) -> Cloud API JSON
 */

/** Something a person did, normalized away from the channel it arrived on. */
export type InboundEvent = {
  /** E.164 without '+', e.g. "50499990001". */
  from: string;
  /** Provider message id, used to drop duplicate webhook deliveries. */
  messageId: string;
  at: number;
  payload: InboundPayload;
};

export type InboundPayload =
  | { kind: "text"; text: string }
  | { kind: "location"; lat: number; lng: number }
  /** A tapped reply button. `id` is ours, set when the message was sent. */
  | { kind: "button"; id: string; title: string }
  /** A tapped row in a list menu. */
  | { kind: "list"; id: string; title: string }
  /** Anything we do not handle (sticker, image, audio...). */
  | { kind: "other"; description: string };

/** Something the bot wants to say, described in intent rather than in Cloud API JSON. */
export type OutboundMessage = {
  to: string;
  spec: OutboundSpec;
};

export type OutboundSpec =
  | { kind: "text"; body: string }
  /** Renders as WhatsApp's native "Send location" button. */
  | { kind: "locationRequest"; body: string }
  /** A pin we send to a driver so they can navigate to the customer. */
  | { kind: "location"; lat: number; lng: number; name?: string; address?: string }
  /** Max 3 buttons — a WhatsApp limit, enforced in the renderer. */
  | { kind: "buttons"; body: string; buttons: Button[] }
  /** Max 10 rows total across all sections — also a WhatsApp limit. */
  | { kind: "list"; body: string; buttonLabel: string; sections: ListSection[] };

export type Button = { id: string; title: string };

export type ListSection = {
  title?: string;
  rows: ListRow[];
};

export type ListRow = {
  id: string;
  title: string;
  description?: string;
};

/**
 * How outbound messages leave the domain. Production sends to Meta; DEV_MODE
 * records into `dev_outbox` for the harness; tests collect in memory.
 */
export interface Transport {
  send(message: OutboundMessage): Promise<void>;
}

/** WhatsApp's hard limits, asserted at render time so tests catch violations. */
export const WA_MAX_BUTTONS = 3;
export const WA_MAX_LIST_ROWS = 10;
export const WA_MAX_BUTTON_TITLE = 20;
export const WA_MAX_ROW_TITLE = 24;

/**
 * Fit database text into a list-row title.
 *
 * The gazetteer is hand-entered by people who are not counting characters, and
 * the renderer refuses an over-long row by throwing — which rejects the whole
 * menu, so one 26-character landmark name means the customer gets no reply at
 * all and the conversation dead-ends. Trimming every title built from database
 * text keeps the renderer's assertion as a backstop for programming errors
 * without letting data reach it.
 *
 * Counted in code points, exactly as the renderer counts, so the two can never
 * disagree about a name containing an accent or an emoji.
 */
export function fitRowTitle(text: string): string {
  const chars = [...text];
  if (chars.length <= WA_MAX_ROW_TITLE) return text;
  return chars.slice(0, WA_MAX_ROW_TITLE - 1).join("") + "…";
}
