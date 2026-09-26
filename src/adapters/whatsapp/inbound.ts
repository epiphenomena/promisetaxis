/**
 * Cloud API webhook JSON → normalized InboundEvent.
 *
 * One of exactly two functions that know Meta's field names. Everything past
 * this point sees only `InboundEvent`.
 */

import type { InboundEvent, InboundPayload } from "../../domain/types";

type WebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WaMessage[];
      };
    }>;
  }>;
};

type WaMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  location?: { latitude?: number; longitude?: number };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  // Template quick-replies arrive as `button`, not `interactive`.
  button?: { payload?: string; text?: string };
};

export function parseInbound(body: unknown): InboundEvent[] {
  const parsed = body as WebhookBody;
  const events: InboundEvent[] = [];

  for (const entry of parsed?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        const event = parseMessage(msg);
        if (event) events.push(event);
      }
    }
  }

  return events;
}

function parseMessage(msg: WaMessage): InboundEvent | null {
  const from = msg.from;
  const messageId = msg.id;
  if (!from || !messageId) return null;

  // Meta sends seconds; the rest of the system works in milliseconds.
  const at = msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now();
  const payload = parsePayload(msg);
  if (!payload) return null;

  return { from, messageId, at, payload };
}

function parsePayload(msg: WaMessage): InboundPayload | null {
  switch (msg.type) {
    case "text": {
      const text = msg.text?.body;
      return text ? { kind: "text", text } : null;
    }

    case "location": {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;
      if (typeof lat !== "number" || typeof lng !== "number") return null;
      return { kind: "location", lat, lng };
    }

    case "interactive": {
      const i = msg.interactive;
      if (i?.type === "button_reply" && i.button_reply?.id) {
        return { kind: "button", id: i.button_reply.id, title: i.button_reply.title ?? "" };
      }
      if (i?.type === "list_reply" && i.list_reply?.id) {
        return { kind: "list", id: i.list_reply.id, title: i.list_reply.title ?? "" };
      }
      return { kind: "other", description: `interactive:${i?.type ?? "unknown"}` };
    }

    case "button": {
      const id = msg.button?.payload;
      return id
        ? { kind: "button", id, title: msg.button?.text ?? "" }
        : { kind: "other", description: "button:no-payload" };
    }

    default:
      return { kind: "other", description: msg.type ?? "unknown" };
  }
}
