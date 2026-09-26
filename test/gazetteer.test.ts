/**
 * Guards on the shipped gazetteer, asserted against `seeds/dev.sql` itself.
 *
 * Every other test file builds its own small fixture. These read the real file,
 * because the nonprofit will replace this data wholesale after walking the town
 * with a GPS — and that is precisely the moment a hand-typed name two characters
 * too long, or a pin that lands in the wrong zone, needs to be caught by a test
 * rather than by a customer whose conversation dead-ends.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { renderOutbound } from "../src/adapters/whatsapp/outbound";
import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { listLandmarks, listZones, zoneForPoint } from "../src/domain/places";
import { fitRowTitle } from "../src/domain/types";
import { AT, T0, inbound, makeCtx, setupDevSeed } from "./helpers";

beforeEach(setupDevSeed);

describe("seeded menus", () => {
  it("renders a menu for every zone and landmark in the seed", async () => {
    const tx = new MemoryTransport();
    const zones = await listZones(env.DB);
    // A seed that loaded nothing would pass every assertion below forever.
    expect(zones.length).toBeGreaterThan(0);

    let rendered = 0;
    for (const zone of zones) {
      // One number per zone: a customer who has tapped through is 'waiting', and
      // every later message gets alreadyWaiting instead of a menu.
      const phone = `50488881${String(zone.sort_order).padStart(3, "0")}`;
      const ctx = makeCtx(tx, T0);

      await inbound(ctx, phone, { kind: "text", text: "necesito un tuktuk" });
      await inbound(ctx, phone, { kind: "location", ...AT.parqueCentral });
      await inbound(ctx, phone, { kind: "list", id: `zone:${zone.id}`, title: zone.name });

      const menus = tx.to(phone);
      expect(menus.length, `${zone.id} answered nothing`).toBe(3);
      for (const message of menus) {
        expect(
          () => renderOutbound(message),
          `${zone.id}: ${JSON.stringify(message.spec)}`,
        ).not.toThrow();
        rendered++;
      }
    }

    expect(rendered).toBe(zones.length * 3);
  });

  it("names every zone and landmark within the row-title limit", async () => {
    // Trimming at spec-construction time means an over-long name can no longer
    // dead-end a conversation, which is also why it can no longer fail the test
    // above. So the data is held to the stricter rule: a name the office has to
    // read as "Hospital / Centro de sa…" on a phone is a name to shorten by hand,
    // and this is where whoever replaces the gazetteer finds that out.
    const names = [
      ...(await listZones(env.DB)).map((z) => [`zone ${z.id}`, z.name] as const),
      ...(
        await env.DB.prepare("SELECT id, name FROM landmarks").all<{ id: string; name: string }>()
      ).results.map((lm) => [`landmark ${lm.id}`, lm.name] as const),
    ];
    expect(names.length).toBeGreaterThan(0);

    for (const [what, name] of names) {
      expect(fitRowTitle(name), `${what} is trimmed to fit a list row`).toBe(name);
    }
  });

  it("keeps every landmark reachable from its zone's menu", async () => {
    const tx = new MemoryTransport();
    const zones = await listZones(env.DB);

    for (const zone of zones) {
      const phone = `50488882${String(zone.sort_order).padStart(3, "0")}`;
      const ctx = makeCtx(tx, T0);

      await inbound(ctx, phone, { kind: "text", text: "necesito un tuktuk" });
      await inbound(ctx, phone, { kind: "location", ...AT.parqueCentral });
      await inbound(ctx, phone, { kind: "list", id: `zone:${zone.id}`, title: zone.name });

      const menu = tx.last(phone)!;
      if (menu.spec.kind !== "list") throw new Error(`${zone.id}: expected a list`);
      const ids = menu.spec.sections.flatMap((s) => s.rows.map((r) => r.id));

      // The 10-row ceiling is the reason the header asks for 9 landmarks a zone:
      // an overfull zone silently loses whichever landmarks sort last.
      for (const lm of await listLandmarks(env.DB, zone.id)) {
        expect(ids, `${lm.id} is not on the ${zone.id} menu`).toContain(`lm:${lm.id}`);
      }
    }
  });
});

describe("seeded geography", () => {
  it("puts every landmark's pin in the zone it is declared in", async () => {
    const zones = await listZones(env.DB);
    let checked = 0;

    for (const zone of zones) {
      for (const lm of await listLandmarks(env.DB, zone.id)) {
        if (lm.lat === null || lm.lng === null) continue;

        // A customer who taps this landmark gets a trip whose dest_zone_id is the
        // declared zone, so routing scores against wherever that zone is — not
        // where the pin says the place is.
        const snapped = await zoneForPoint(env.DB, { lat: lm.lat, lng: lm.lng });
        expect(
          snapped?.id,
          `${lm.id} is declared in ${lm.zone_id} but its pin snaps to ${snapped?.id}`,
        ).toBe(lm.zone_id);
        checked++;
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it("has a travel time for every ordered pair of zones", async () => {
    const zones = await listZones(env.DB);

    for (const from of zones) {
      for (const to of zones) {
        const row = await env.DB.prepare(
          "SELECT minutes FROM zone_times WHERE from_zone = ? AND to_zone = ?",
        )
          .bind(from.id, to.id)
          .first<{ minutes: number }>();

        // travelMinutes falls back to a flat pessimistic 10 for a missing pair,
        // which quietly flattens the scoring that picks a driver.
        expect(row?.minutes, `no travel time for ${from.id} → ${to.id}`).toBeGreaterThan(0);
      }
    }
  });
});
