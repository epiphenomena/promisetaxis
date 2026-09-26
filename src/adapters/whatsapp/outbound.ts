/**
 * OutboundSpec → Cloud API JSON.
 *
 * The other half of the boundary. WhatsApp's hard limits are asserted here
 * rather than trusted, so a menu that grew past 10 rows fails in a unit test
 * instead of silently truncating in front of a customer.
 */

import {
  WA_MAX_BUTTONS,
  WA_MAX_BUTTON_TITLE,
  WA_MAX_LIST_ROWS,
  WA_MAX_ROW_TITLE,
  type OutboundMessage,
} from "../../domain/types";

export class OutboundLimitError extends Error {}

export function renderOutbound(message: OutboundMessage): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: message.to,
  };

  const spec = message.spec;

  switch (spec.kind) {
    case "text":
      return { ...base, type: "text", text: { preview_url: false, body: spec.body } };

    case "location":
      return {
        ...base,
        type: "location",
        location: {
          latitude: spec.lat,
          longitude: spec.lng,
          name: spec.name ?? "",
          address: spec.address ?? "",
        },
      };

    case "locationRequest":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: { text: spec.body },
          action: { name: "send_location" },
        },
      };

    case "buttons": {
      if (spec.buttons.length === 0 || spec.buttons.length > WA_MAX_BUTTONS) {
        throw new OutboundLimitError(
          `WhatsApp allows 1–${WA_MAX_BUTTONS} reply buttons, got ${spec.buttons.length}`,
        );
      }
      for (const b of spec.buttons) {
        if ([...b.title].length > WA_MAX_BUTTON_TITLE) {
          throw new OutboundLimitError(
            `Button title over ${WA_MAX_BUTTON_TITLE} chars: "${b.title}"`,
          );
        }
      }
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: spec.body },
          action: {
            buttons: spec.buttons.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    }

    case "list": {
      const rowCount = spec.sections.reduce((n, s) => n + s.rows.length, 0);
      if (rowCount === 0 || rowCount > WA_MAX_LIST_ROWS) {
        throw new OutboundLimitError(
          `WhatsApp allows 1–${WA_MAX_LIST_ROWS} list rows across all sections, got ${rowCount}`,
        );
      }
      for (const section of spec.sections) {
        for (const row of section.rows) {
          if ([...row.title].length > WA_MAX_ROW_TITLE) {
            throw new OutboundLimitError(
              `List row title over ${WA_MAX_ROW_TITLE} chars: "${row.title}"`,
            );
          }
        }
      }
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: spec.body },
          action: {
            button: spec.buttonLabel,
            sections: spec.sections.map((s) => ({
              ...(s.title ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          },
        },
      };
    }
  }
}
