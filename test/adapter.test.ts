/**
 * The adapter boundary in both directions.
 *
 * These are the tests that would have caught the three things Meta's docs let
 * you get wrong silently: the 3-button ceiling, the 10-row ceiling, and the
 * fact that `timestamp` arrives in seconds while everything else uses ms.
 */

import { describe, expect, it } from "vitest";
import { parseInbound } from "../src/adapters/whatsapp/inbound";
import { renderOutbound, OutboundLimitError } from "../src/adapters/whatsapp/outbound";

function webhook(message: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

describe("parseInbound", () => {
  it("reads a location pin — the first step of every hail", () => {
    const [event] = parseInbound(
      webhook({
        from: "50488880001",
        id: "wamid.1",
        timestamp: "1700000000",
        type: "location",
        location: { latitude: 14.8397, longitude: -89.1531 },
      }),
    );

    expect(event?.payload).toEqual({ kind: "location", lat: 14.8397, lng: -89.1531 });
    // Meta sends seconds; the domain works in milliseconds throughout.
    expect(event?.at).toBe(1_700_000_000_000);
  });

  it("reads a tapped reply button as its id, not its label", () => {
    const [event] = parseInbound(
      webhook({
        from: "50499990001",
        id: "wamid.2",
        timestamp: "1700000000",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "drv:done", title: "✅ Listo" } },
      }),
    );

    expect(event?.payload).toEqual({ kind: "button", id: "drv:done", title: "✅ Listo" });
  });

  it("reads a tapped list row", () => {
    const [event] = parseInbound(
      webhook({
        from: "50488880001",
        id: "wamid.3",
        timestamp: "1700000000",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "lm:terminal", title: "Terminal" } },
      }),
    );

    expect(event?.payload).toEqual({ kind: "list", id: "lm:terminal", title: "Terminal" });
  });

  it("survives webhook deliveries that carry no messages at all", () => {
    // Meta sends status-only callbacks (delivered/read) constantly.
    expect(parseInbound({ entry: [{ changes: [{ value: { statuses: [] } }] }] })).toEqual([]);
    expect(parseInbound({})).toEqual([]);
    expect(parseInbound(null)).toEqual([]);
  });

  it("degrades unknown message types instead of dropping the conversation", () => {
    const [event] = parseInbound(
      webhook({ from: "50488880001", id: "wamid.4", timestamp: "1700000000", type: "sticker" }),
    );
    expect(event?.payload.kind).toBe("other");
  });
});

describe("renderOutbound", () => {
  it("renders the location request that opens every hail", () => {
    const json = renderOutbound({
      to: "50488880001",
      spec: { kind: "locationRequest", body: "¿Dónde está?" },
    }) as any;

    expect(json.type).toBe("interactive");
    expect(json.interactive.type).toBe("location_request_message");
    expect(json.interactive.action.name).toBe("send_location");
  });

  it("refuses a fourth reply button", () => {
    // The driver interface is exactly three. A fourth must fail here, in a
    // test, rather than as a 400 from Meta with a driver waiting.
    expect(() =>
      renderOutbound({
        to: "50499990001",
        spec: {
          kind: "buttons",
          body: "…",
          buttons: [
            { id: "a", title: "Uno" },
            { id: "b", title: "Dos" },
            { id: "c", title: "Tres" },
            { id: "d", title: "Cuatro" },
          ],
        },
      }),
    ).toThrow(OutboundLimitError);
  });

  it("refuses an eleventh list row across all sections", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, title: `Fila ${i}` }));
    expect(() =>
      renderOutbound({
        to: "50488880001",
        spec: {
          kind: "list",
          body: "…",
          buttonLabel: "Ver",
          sections: [{ rows }, { rows }],
        },
      }),
    ).toThrow(OutboundLimitError);
  });

  it("counts emoji in button titles by character, not by UTF-16 unit", () => {
    // "✅ Listo" is 7 characters but 8 UTF-16 units; a naive .length check
    // would reject perfectly valid labels once emoji are involved.
    const title = "✅ " + "a".repeat(18);
    expect([...title].length).toBe(20);
    expect(() =>
      renderOutbound({
        to: "50499990001",
        spec: { kind: "buttons", body: "…", buttons: [{ id: "a", title }] },
      }),
    ).not.toThrow();
  });
});
